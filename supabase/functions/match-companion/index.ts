// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const GAME_CODE = (Deno.env.get("FC_DATABASE_GAME_CODE") || "fc27").trim().toLowerCase();
const FCRADAR_PLAYERS_URL = `https://pub-api.fcradar.gg/v1/games/${GAME_CODE}/players`;
const RATING_TTL_DAYS = 14;

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
  suggestions?: Array<{ id: string; name: string; club: string; position: string; rating: number | null; url: string }>;
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

        if (!Array.isArray(body.players) || body.players.length > 60) {
          return Response.json({ ok: false, error: "A lineup of up to 60 players is required." }, { status: 400 });
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

  // A 14-day rating cache is edition-specific, while the player identity is not.
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
  let identitySource = "fcradar_verified_id";
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
    identitySource = lookup.source || "fcradar_name_club_position";
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

  // FotMob remains the display-name source of truth. FCRadar names are matching metadata only.
  const playerName = player.name;
  const clubValue = fcradarPlayer.club;
  const club = String(
    (clubValue && typeof clubValue === "object"
      ? (clubValue as Record<string, unknown>).name
      : clubValue) ??
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
    identity_source: identitySource,
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
): Promise<{ status: "matched" | "not_found" | "ambiguous"; player?: FCRadarPlayer; rating: number | null; source?: string; suggestions?: RatingResult["suggestions"] }> {
  const queryNames = buildSearchNames(player.name);
  const allCandidates = new Map<string, FCRadarPlayer>();

  // Search the full FotMob name first. Only broaden the search when that does not
  // produce a credible candidate, keeping API usage low for ordinary matches.
  for (const query of queryNames) {
    const url = new URL(FCRADAR_PLAYERS_URL);
    url.searchParams.set("search", query);
    url.searchParams.set("pageSize", "100");

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

    const candidates = extractPlayers(await response.json());
    for (const candidate of candidates) {
      const id = candidate.id ?? candidate.playerId;
      if (id != null) allCandidates.set(String(id), candidate);
    }

    const ranked = rankCandidates(player, [...allCandidates.values()]);
    if (ranked.selected) {
      console.info("FCRadar player matched:", {
        requestedName: player.name,
        playerId: ranked.selected.id ?? ranked.selected.playerId,
        matchSource: ranked.source,
        candidateCount: allCandidates.size,
        fotmobId: player.fotmobId ?? null,
      });
      return { rating: null, status: "matched", player: ranked.selected, source: ranked.source };
    }

    // An exact-name search with an unresolved ambiguity may benefit from a
    // surname/known-alias query, so continue through the small query list.
  }

  const ranked = rankCandidates(player, [...allCandidates.values()]);
  console.info("FCRadar player not confidently matched:", {
    requestedName: player.name,
    requestedClub: player.team || null,
    requestedPosition: player.position || null,
    candidateCount: allCandidates.size,
    status: ranked.ambiguous ? "ambiguous" : "not_found",
    fotmobId: player.fotmobId ?? null,
  });
  const suggestions = [...allCandidates.values()]
    .map(toCandidateSuggestion)
    .filter((item): item is NonNullable<RatingResult["suggestions"]>[number] => item !== null)
    .slice(0, 8);
  return {
    rating: null,
    status: ranked.ambiguous ? "ambiguous" : "not_found",
    suggestions,
  };
}

function buildSearchNames(name: string): string[] {
  const queries = [name.trim()];
  const normalized = normalize(name);
  const aliases: Record<string, string[]> = {
    franciswestfield: ["Frankie Westfield"],
  };
  for (const alias of aliases[normalized] || []) queries.push(alias);

  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) queries.push(parts[parts.length - 1]);

  return [...new Set(queries.filter(Boolean))].slice(0, 3);
}

function rankCandidates(
  player: PlayerRequest,
  candidates: FCRadarPlayer[],
): { selected?: FCRadarPlayer; source?: string; ambiguous: boolean } {
  const requestedName = normalize(player.name);
  const requestedClub = normalizeClub(player.team || "");
  const requestedPosition = normalizePosition(player.position || "");
  const aliases: Record<string, string[]> = {
    franciswestfield: ["frankiewestfield"],
  };
  const acceptedNames = new Set([requestedName, ...(aliases[requestedName] || [])]);

  const ranked = candidates.map(candidate => {
    const names = getCandidateNames(candidate).map(normalize);
    const exactName = names.some(name => acceptedNames.has(name));
    const surname = normalize(player.name.trim().split(/\s+/).slice(-1)[0] || "");
    const surnameOnly = !exactName && surname.length >= 4 && names.some(name =>
      name === surname || name.includes(surname)
    );
    if (!exactName && !surnameOnly) return null;

    const candidateClub = normalizeClub(getCandidateClub(candidate));
    const clubMatch = Boolean(requestedClub && candidateClub &&
      (requestedClub === candidateClub ||
       requestedClub.includes(candidateClub) ||
       candidateClub.includes(requestedClub)));
    const candidatePositionValue =
      candidate.position ?? candidate.positions ?? candidate.primaryPosition ?? "";
    const positionScore = getPositionMatchScore(requestedPosition, candidatePositionValue);
    const hasCandidatePosition = positionTokens(candidatePositionValue).length > 0;
    const positionConflict = Boolean(requestedPosition && hasCandidatePosition && positionScore === 0);

    // Never let a surname-only match through without both club and position.
    if (surnameOnly && (!clubMatch || positionScore === 0)) return null;
    // A position from a different playing unit is a hard rejection.
    if (positionConflict) return null;

    const score = (exactName ? 100 : 45) +
      (clubMatch ? 45 : 0) +
      positionScore;
    return {
      candidate,
      score,
      source: surnameOnly ? "fcradar_surname_club_position"
        : acceptedNames.has(names.find(name => acceptedNames.has(name)) || "")
          ? "fcradar_exact_or_alias_name"
          : "fcradar_name_club_position",
    };
  }).filter((item): item is { candidate: FCRadarPlayer; score: number; source: string } => item !== null)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return { ambiguous: false };
  if (ranked.length === 1) return { selected: ranked[0].candidate, source: ranked[0].source, ambiguous: false };

  const first = ranked[0];
  const second = ranked[1];
  // Require a clear lead when multiple same-name candidates exist.
  if (first.score > second.score && first.score - second.score >= 20) {
    return { selected: first.candidate, source: first.source, ambiguous: false };
  }
  return { ambiguous: true };
}

function toCandidateSuggestion(candidate: FCRadarPlayer): NonNullable<RatingResult["suggestions"]>[number] | null {
  const id = candidate.id ?? candidate.playerId;
  if (id == null) return null;
  const name = getCandidateNames(candidate)[0] || "Unknown player";
  const club = getCandidateClub(candidate);
  const positionValue = candidate.position ?? candidate.positions ?? candidate.primaryPosition ?? "";
  const position = Array.isArray(positionValue)
    ? positionValue.map(item => typeof item === "object" && item
      ? String((item as Record<string, unknown>).code ?? (item as Record<string, unknown>).name ?? "")
      : String(item)).filter(Boolean).join(", ")
    : typeof positionValue === "object" && positionValue
      ? String((positionValue as Record<string, unknown>).code ?? (positionValue as Record<string, unknown>).name ?? "")
      : String(positionValue);
  const rawRating = candidate.overall_rating ?? candidate.overall ?? candidate.ovr ?? candidate.rating;
  const numericRating = Number(rawRating);
  const slug = name.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return {
    id: String(id),
    name,
    club,
    position,
    rating: Number.isFinite(numericRating) && numericRating > 0 ? Math.round(numericRating) : null,
    url: `https://fcradar.gg/${GAME_CODE}/players/latest/${slug}/${encodeURIComponent(String(id))}`,
  };
}

function getCandidateNames(candidate: FCRadarPlayer): string[] {
  const firstLast = [candidate.first_name, candidate.last_name]
    .filter(value => typeof value === "string" && value.trim())
    .join(" ");
  return [
    candidate.name, candidate.fullName, candidate.shortName,
    candidate.common_name, candidate.playerName, firstLast,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function getCandidateClub(candidate: FCRadarPlayer): string {
  const value = candidate.club ?? candidate.clubName ?? candidate.team ?? candidate.teamName;
  if (value && typeof value === "object") {
    const club = value as Record<string, unknown>;
    return String(club.name ?? club.shortName ?? club.displayName ?? "");
  }
  return String(value ?? "");
}

function normalizeClub(value: string): string {
  return normalize(value)
    .replace(/^(club|cf|fc|afc|deportivo|cd|real)/, "");
}

function getPositionMatchScore(requested: string, candidateValue: unknown): number {
  if (!requested) return 0;
  const candidates = positionTokens(candidateValue);
  if (!candidates.length) return 0;

  const group = (position: string) => {
    if (["GK", "GOALKEEPER"].includes(position)) return "GK";
    if (["CB", "LCB", "RCB", "LB", "RB", "LWB", "RWB", "DEF", "DEFENDER"].includes(position)) return "DEF";
    if (["CDM", "CM", "CAM", "LM", "RM", "MID", "MIDFIELDER"].includes(position)) return "MID";
    if (["LW", "RW", "LF", "RF", "ST", "CF", "ATT", "ATTACKER", "FORWARD"].includes(position)) return "ATT";
    return position;
  };

  return Math.max(...candidates.map(position =>
    requested === position ? 30 : group(requested) === group(position) ? 12 : 0
  ));
}

function positionTokens(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(positionTokens);
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return positionTokens(item.code ?? item.abbreviation ?? item.name ?? item.position);
  }
  return String(value ?? "")
    .split(/[,/| ]+/)
    .map(part => normalizePosition(part))
    .filter(Boolean);
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
