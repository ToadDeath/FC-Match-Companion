// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "jsr:@supabase/server@^1";

const FCRADAR_BASE = "https://pub-api.fcradar.gg/v1/games/fc27/players";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ratingCache = new Map<string, { expiresAt: number; result: RatingResult }>();

interface PlayerRequest {
  key: string;
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
}

console.info("FC Match Companion function started");

export default {
  fetch: withSupabase({ auth: ["publishable"] }, async (req, _ctx) => {
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
            ratings[player.key] = await lookupPlayer(player, apiKey);
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

async function lookupPlayer(player: PlayerRequest, apiKey: string): Promise<RatingResult> {
  const cacheKey = `${normalize(player.name)}|${normalize(player.position || "")}`;
  const cached = ratingCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  const url = new URL(FCRADAR_BASE);
  url.searchParams.set("search", player.name);
  url.searchParams.set("pageSize", "10");

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.status === 429) {
    const result: RatingResult = { rating: null, status: "not_found" };
    return result;
  }
  if (!response.ok) {
    const detail = await response.text();
    console.error("FCRadar API error:", response.status, detail.slice(0, 500));
    throw new Error(`FCRadar returned HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const candidates = extractPlayers(payload);
  const exact = candidates.filter(candidate =>
    normalize(candidate.name ?? candidate.fullName ?? candidate.shortName ?? "") === normalize(player.name)
  );

  let selected: Record<string, unknown> | undefined;
  if (exact.length === 1) {
    selected = exact[0];
  } else if (exact.length > 1 && player.position) {
    const positionMatches = exact.filter(candidate =>
      normalizePosition(candidate.position ?? candidate.positions) === normalizePosition(player.position)
    );
    if (positionMatches.length === 1) selected = positionMatches[0];
  }

  let result: RatingResult;
  if (!selected) {
    result = {
      rating: null,
      status: exact.length > 1 ? "ambiguous" : "not_found",
    };
  } else {
    const rawRating = selected.overall ?? selected.ovr ?? selected.rating ??
      (selected.ratings as Record<string, unknown> | undefined)?.overall;
    const numericRating = Number(rawRating);
    result = {
      rating: Number.isFinite(numericRating) && numericRating > 0 ? numericRating : null,
      status: Number.isFinite(numericRating) && numericRating > 0 ? "matched" : "not_found",
      playerName: String(selected.name ?? selected.fullName ?? player.name),
      club: String(
        (selected.club as Record<string, unknown> | undefined)?.name ??
        selected.clubName ?? selected.teamName ?? ""
      ),
      playerId: (selected.id ?? selected.playerId) as string | number | undefined,
    };
  }

  ratingCache.set(cacheKey, { expiresAt: Date.now() + CACHE_TTL_MS, result });
  return result;
}

function extractPlayers(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[];
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const data = root.data;
  if (Array.isArray(root.players)) return root.players as Record<string, unknown>[];
  if (Array.isArray(root.results)) return root.results as Record<string, unknown>[];
  if (Array.isArray(root.items)) return root.items as Record<string, unknown>[];
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const nested = data as Record<string, unknown>;
    if (Array.isArray(nested.players)) return nested.players as Record<string, unknown>[];
    if (Array.isArray(nested.results)) return nested.results as Record<string, unknown>[];
    if (Array.isArray(nested.items)) return nested.items as Record<string, unknown>[];
  }
  return [];
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
