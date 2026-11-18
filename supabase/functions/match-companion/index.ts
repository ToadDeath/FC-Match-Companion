// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const GAME_CODE = "fc27";
const FCRADAR_PLAYERS_URL = `https://pub-api.fcradar.gg/v1/games/${GAME_CODE}/players`;
const RATING_TTL_DAYS = 30;

interface PlayerRequest {
  key: string;
  fotmobId?: string | number | null;
  name: string;
  position?: string;
  team?: string;
}

interface RatingResult {
  rating: number | null;
  status: "matched" | "not_found" | "ambiguous";
  playerName?: string;
  club?: string;
  playerId?: string | number;
  source?: "cache" | "fcradar";
}

type FCRadarPlayer = Record<string, unknown>;

console.info("FC Match Companion function started");

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, ctx) => {
    try {
      const body = await req.json();

      if (body.action === "health") {
        return Response.json({
          ok: true,
          fcradarConfigured: Boolean(Deno.env.get("FCRADAR_API_KEY")),
        });
      }

      if (body.action === "match") {
        const matchId = String(body.matchId || "").trim();
        if (!/^\d{5,}$/.test(matchId)) {
          return Response.json({ ok: false, error: "A valid FotMob match ID is required." }, { status: 400 });
        }

        const response = await fetch(
          `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
          {
            headers: {
              Accept: "application/json",
              "User-Agent": "Mozilla/5.0 FC-Match-Companion/1.0",
            },
          },
        );

        if (!response.ok) {
          console.error("FotMob response:", response.status);
          return Response.json(
            { ok: false, error: `FotMob returned HTTP ${response.status}.` },
            { status: 502 },
          );
        }

        return Response.json({ ok: true, matchId, matchData: await response.json() });
      }

      if (body.action === "ratings") {
        const apiKey = Deno.env.get("FCRADAR_API_KEY");
        if (!apiKey) {
          return Response.json({ ok: false, error: "The FCRadar API key is not configured in Supabase." }, { status: 500 });
        }

        if (!Array.isArray(body.players) || body.players.length > 30) {
          return Response.json({ ok: false, error: "A lineup of up to 30 players is required." }, { status: 400 });
        }

        const players = body.players as PlayerRequest[];
        const ratings: Record<string, RatingResult> = {};
        let nextIndex = 0;

        async function worker() {
          while (nextIndex < players.length) {
            const index = nextIndex++;
            const player = players[index];
            if (!player?.key || !player?.name) continue;
            ratings[player.key] = await lookupPlayer(player, apiKey, ctx.supabaseAdmin);
          }
        }

        await Promise.all(Array.from({ length: Math.min(5, players.length) }, () => worker()));
        return Response.json({ ok: true, ratings });
      }

      return Response.json({ ok: false, error: "Unknown action." }, { status: 400 });
    } catch (error) {
      console.error("FC Match Companion error:", error);
      return Response.json({ ok: false, error: "The server could not complete the request." }, { status: 500 });
    }
  }),
};

async function lookupPlayer(
  player: PlayerRequest,
  apiKey: string,
  db: any,
): Promise<RatingResult> {
  const fotmobId = player.fotmobId == null ? null : String(player.fotmobId);
  let identity: Record<string, unknown> | null = null;

  // The FotMob ID is the primary cross-provider key after the first verified match.
  if (fotmobId) {
    const { data, error } = await db
      .from("fc_player_identities")
      .select("fcradar_player_id, fotmob_player_id, player_name, common_name, first_name, last_name")
      .eq("fotmob_player_id", fotmobId)
      .maybeSingle();
    if (error) throw new Error(`Player identity cache read failed: ${error.message}`);
    identity = data;
  }

  // A 30-day rating cache is edition-specific, while the player identity is not.
  if (identity?.fcradar_player_id) {
    const { data, error } = await db
      .from("fc_player_ratings")
      .select("overall_rating, club_name, position, fetched_at, expires_at")
      .eq("fcradar_player_id", String(identity.fcradar_player_id))
      .eq("game_code", GAME_CODE)
      .gt("expires_at", new Date().toISOString())
      .maybeSingle();

    if (error) throw new Error(`Player rating cache read failed: ${error.message}`);
    if (data) {
      await touchIdentity(db, identity);
      return {
        rating: Number(data.overall_rating),
        status: "matched",
        playerName: String(identity.player_name || player.name),
        club: String(data.club_name || ""),
        playerId: String(identity.fcradar_player_id),
        source: "cache",
      };
    }
  }

  let fcradarPlayer: FCRadarPlayer | undefined;
  if (identity?.fcradar_player_id) {
    fcradarPlayer = await fetchFCRadarPlayerById(String(identity.fcradar_player_id), apiKey);
    if (!fcradarPlayer) {
      console.warn("Mapped FCRadar player ID no longer resolves; trying name lookup", {
        fotmobId,
        fcradarPlayerId: identity.fcradar_player_id,
      });
      identity = null;
    }
  }

  // Only players without a verified ID mapping need name-based discovery.
  if (!fcradarPlayer) {
    const lookup = await findFCRadarPlayer(player, apiKey);
    if (lookup.status !== "matched" || !lookup.player) return lookup;
    fcradarPlayer = lookup.player;
  }

  const fcradarId = fcradarPlayer.id ?? fcradarPlayer.playerId;
  if (fcradarId == null) {
    console.warn("FCRadar player record did not include an ID", { requestedName: player.name });
    return { rating: null, status: "not_found" };
  }

  const playerId = String(fcradarId);
  const rawRating = fcradarPlayer.overall_rating ?? fcradarPlayer.overall ??
    fcradarPlayer.ovr ?? fcradarPlayer.rating ??
    (fcradarPlayer.ratings as Record<string, unknown> | undefined)?.overall;
  const numericRating = Number(rawRating);
  if (!Number.isFinite(numericRating) || numericRating <= 0) {
    return { rating: null, status: "not_found", playerId };
  }

  const playerName = String(
    fcradarPlayer.name ??
    fcradarPlayer.common_name ??
    [fcradarPlayer.first_name, fcradarPlayer.last_name].filter(Boolean).join(" ") ??
    player.name
  );
  const club = String(
    (fcradarPlayer.club as Record<string, unknown> | undefined)?.name ??
    fcradarPlayer.clubName ?? fcradarPlayer.teamName ?? ""
  );
  const position = String(fcradarPlayer.position ?? player.position ?? "");

  // Store the stable cross-provider identity separately from edition-specific ratings.
  const identityRow = {
    fcradar_player_id: playerId,
    fotmob_player_id: fotmobId,
    player_name: playerName,
    common_name: nullableString(fcradarPlayer.common_name),
    first_name: nullableString(fcradarPlayer.first_name),
    last_name: nullableString(fcradarPlayer.last_name),
    identity_source: "fcradar_exact_name",
    last_seen_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { error: identityWriteError } = await db
    .from("fc_player_identities")
    .upsert(identityRow, { onConflict: "fcradar_player_id" });
  if (identityWriteError) {
    // Still return the live rating if identity persistence fails, but make the problem visible.
    console.error("Could not persist player identity mapping:", identityWriteError.message);
  }

  const fetchedAt = new Date();
  const expiresAt = new Date(fetchedAt.getTime() + RATING_TTL_DAYS * 24 * 60 * 60 * 1000);
  const { error: ratingWriteError } = await db
    .from("fc_player_ratings")
    .upsert({
      fcradar_player_id: playerId,
      game_code: GAME_CODE,
      overall_rating: Math.round(numericRating),
      club_name: club || null,
      position: position || null,
      fetched_at: fetchedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    }, { onConflict: "fcradar_player_id,game_code" });

  if (ratingWriteError) {
    console.error("Could not persist player rating:", ratingWriteError.message);
  }

  return {
    rating: Math.round(numericRating),
    status: "matched",
    playerName,
    club,
    playerId,
    source: "fcradar",
  };
}

async function findFCRadarPlayer(
  player: PlayerRequest,
  apiKey: string,
): Promise<{ status: "matched" | "not_found" | "ambiguous"; player?: FCRadarPlayer; rating: number | null }> {
  const url = new URL(FCRADAR_PLAYERS_URL);
  url.searchParams.set("search", player.name);
  url.searchParams.set("pageSize", "10");

  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === 429) {
    console.warn("FCRadar rate limit reached during player search");
    return { rating: null, status: "not_found" };
  }
  if (!response.ok) {
    console.error("FCRadar search failed:", response.status, (await response.text()).slice(0, 300));
    throw new Error(`FCRadar returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const candidates = extractPlayers(payload);
  console.info("FCRadar player search:", {
    requestedName: player.name,
    httpStatus: response.status,
    candidateCount: candidates.length,
    fotmobId: player.fotmobId ?? null,
  });

  const requested = normalize(player.name);
  const exact = candidates.filter(candidate => {
    const firstLast = [candidate.first_name, candidate.last_name]
      .filter(value => typeof value === "string" && value.trim())
      .join(" ");
    const names = [
      candidate.name,
      candidate.fullName,
      candidate.shortName,
      candidate.common_name,
      firstLast,
    ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
    return names.some(name => normalize(name) === requested);
  });

  let selected: FCRadarPlayer | undefined;
  if (exact.length === 1) {
    selected = exact[0];
  } else if (exact.length > 1 && player.position) {
    const positionMatches = exact.filter(candidate =>
      normalizePosition(candidate.position ?? candidate.positions) === normalizePosition(player.position)
    );
    if (positionMatches.length === 1) selected = positionMatches[0];
  }

  if (!selected) {
    return { rating: null, status: exact.length > 1 ? "ambiguous" : "not_found" };
  }
  return { rating: null, status: "matched", player: selected };
}

async function fetchFCRadarPlayerById(playerId: string, apiKey: string): Promise<FCRadarPlayer | undefined> {
  const response = await fetch(`${FCRADAR_PLAYERS_URL}/${encodeURIComponent(playerId)}`, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (response.status === 404) return undefined;
  if (response.status === 429) throw new Error("FCRadar rate limit reached while refreshing a player.");
  if (!response.ok) {
    console.error("FCRadar player refresh failed:", response.status, (await response.text()).slice(0, 300));
    throw new Error(`FCRadar returned HTTP ${response.status} while refreshing a player.`);
  }
  return extractPlayerRecord(await response.json());
}

function extractPlayers(payload: unknown, depth = 0): FCRadarPlayer[] {
  if (depth > 4 || !payload || typeof payload !== "object") return [];
  if (Array.isArray(payload)) {
    return payload.filter(item => item && typeof item === "object") as FCRadarPlayer[];
  }
  const root = payload as Record<string, unknown>;
  for (const key of ["players", "results", "items", "records", "content", "data"]) {
    const value = root[key];
    if (Array.isArray(value)) {
      const records = value.filter(item => item && typeof item === "object") as FCRadarPlayer[];
      if (records.length || value.length === 0) return records;
    }
    if (value && typeof value === "object") {
      const nested = extractPlayers(value, depth + 1);
      if (nested.length) return nested;
    }
  }
  return [];
}

function extractPlayerRecord(payload: unknown, depth = 0): FCRadarPlayer | undefined {
  if (depth > 4 || !payload || typeof payload !== "object") return undefined;
  if (Array.isArray(payload)) {
    return payload.length ? extractPlayerRecord(payload[0], depth + 1) : undefined;
  }
  const root = payload as FCRadarPlayer;
  if (root.id != null || root.playerId != null) return root;
  for (const key of ["player", "data", "result", "item"]) {
    if (root[key] && typeof root[key] === "object") {
      const found = extractPlayerRecord(root[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

async function touchIdentity(db: any, identity: Record<string, unknown>) {
  const { error } = await db
    .from("fc_player_identities")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("fcradar_player_id", String(identity.fcradar_player_id));
  if (error) console.warn("Could not update player last-seen timestamp:", error.message);
}

function nullableString(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function normalize(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizePosition(value: unknown): string {
  const raw = Array.isArray(value) ? value.join(" ") : String(value ?? "");
  const token = raw.toUpperCase().replace(/[^A-Z]/g, "");
  const aliases: Record<string, string> = {
    GOALKEEPER: "GK", CENTERBACK: "CB", CENTREBACK: "CB",
    LEFTBACK: "LB", RIGHTBACK: "RB", CENTRALMIDFIELDER: "CM",
    DEFENSIVEMIDFIELDER: "CDM", ATTACKINGMIDFIELDER: "CAM",
    LEFTWINGER: "LW", RIGHTWINGER: "RW", STRIKER: "ST",
    CENTREFORWARD: "CF", CENTERFORWARD: "CF",
  };
  return aliases[token] || token;
}
