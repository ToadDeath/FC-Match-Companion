const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed." }, 405);

  try {
    const body = await req.json();
    if (body.action === "health") {
      return json({
        ok: true,
        fcradarConfigured: Boolean(Deno.env.get("FCRADAR_API_KEY")),
      });
    }
    if (body.action !== "match") return json({ ok: false, error: "Unknown action." }, 400);

    const matchId = String(body.matchId || "").trim();
    if (!/^\d{5,}$/.test(matchId)) {
      return json({ ok: false, error: "A valid FotMob match ID is required." }, 400);
    }

    const response = await fetch(
      `https://www.fotmob.com/api/data/matchDetails?matchId=${encodeURIComponent(matchId)}`,
      { headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0 FC-Match-Companion/1.0" } },
    );
    if (!response.ok) {
      return json({ ok: false, error: `FotMob returned HTTP ${response.status}.` }, 502);
    }
    const matchData = await response.json();
    return json({ ok: true, matchId, matchData });
  } catch (error) {
    console.error("match-companion error", error);
    return json({ ok: false, error: "The server could not load this match." }, 500);
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
