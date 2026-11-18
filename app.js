import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.FC_MATCH_CONFIG || {};
const form = document.querySelector("#match-form");
const urlInput = document.querySelector("#match-url");
const loadButton = document.querySelector("#load-button");
const statusEl = document.querySelector("#status");
const matchContent = document.querySelector("#match-content");
const emptyState = document.querySelector("#empty-state");
const matchTitle = document.querySelector("#match-title");
const modeButtons = [...document.querySelectorAll(".switch-option")];

let ratingMode = "fotmob";
let currentMatch = null;
let supabase = null;
let fcLookupPromise = null;

const configured = Boolean(config.supabaseUrl && config.supabaseAnonKey &&
  config.supabaseAnonKey !== "PASTE_SUPABASE_ANON_KEY_HERE");
if (configured) supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

function setStatus(message, type = "") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
}

function matchIdFromUrl(value) {
  try {
    const url = new URL(value);
    const hashId = url.hash.match(/(?:^#|:)(\d{5,})/);
    const queryId = url.searchParams.get("matchId");
    return queryId || (hashId && hashId[1]) || null;
  } catch {
    return null;
  }
}

function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

function getTeamLineup(lineup, side, teamId) {
  const named = lineup?.[side === "home" ? "homeTeam" : "awayTeam"];
  if (named) return named;
  const list = Array.isArray(lineup?.lineup) ? lineup.lineup : [];
  return list.find(team => String(team.id ?? team.teamId) === String(teamId)) ||
    list[side === "home" ? 0 : 1] || {};
}

function getPlayers(team) {
  const players = team?.starters || team?.players || [];
  return Array.isArray(players) ? players : [];
}

function playerRating(player) {
  const value = player?.performance?.rating ?? player?.rating ??
    player?.stats?.rating ?? player?.performance?.fotmobRating;
  return value === null || value === undefined || value === "" ? "" : String(value);
}

function playerKey(player, side) {
  const name = player?.name || player?.localizedName || "Unknown player";
  const identity = player?.id ?? player?.playerId ?? player?.shirtNumber ??
    player?.number ?? name;
  return `${side}:${identity}:${name}`;
}

function collectPlayers(match) {
  const general = match?.general || {};
  const headerTeams = match?.header?.teams || [];
  const homeHeader = headerTeams[0] || general.homeTeam || {};
  const awayHeader = headerTeams[1] || general.awayTeam || {};
  const lineup = match?.content?.lineup || {};
  const home = getTeamLineup(lineup, "home", homeHeader.id || general.homeTeam?.id);
  const away = getTeamLineup(lineup, "away", awayHeader.id || general.awayTeam?.id);
  const homeName = homeHeader.name || home.name || "Home";
  const awayName = awayHeader.name || away.name || "Away";
  return [
    ...getPlayers(home).map(player => ({
      key: playerKey(player, "home"),
      name: player?.name || player?.localizedName || "",
      position: player?.positionName || player?.position || player?.usualPosition || "",
      team: homeName,
    })),
    ...getPlayers(away).map(player => ({
      key: playerKey(player, "away"),
      name: player?.name || player?.localizedName || "",
      position: player?.positionName || player?.position || player?.usualPosition || "",
      team: awayName,
    })),
  ].filter(player => player.name);
}

function renderPlayer(player, side, fcRatings = {}) {
  const name = player?.name || player?.localizedName || "Unknown player";
  const number = player?.shirtNumber ?? player?.number ?? "";
  const position = player?.positionName || player?.position || player?.usualPosition || "";
  const fotmob = playerRating(player);
  const key = playerKey(player, side);
  const fcResult = fcRatings[key];
  const fcRating = fcResult?.rating === null || fcResult?.rating === undefined
    ? "" : String(fcResult.rating);
  const displayed = ratingMode === "fotmob" ? fotmob : fcRating;
  const title = ratingMode === "fc" && fcResult?.status === "ambiguous"
    ? "Multiple FCRadar players share this name; rating not assigned"
    : ratingMode === "fc" && !fcRating
      ? "No confident FC Database player match found"
      : "";
  return `
    <div class="player-row">
      <span class="player-number">${safeText(number || "·")}</span>
      <span class="player-name">${safeText(name)}${position ? `<small>${safeText(position)}</small>` : ""}</span>
      <span class="player-rating ${displayed ? "" : "rating-unavailable"}" title="${safeText(title)}">${safeText(displayed || "—")}</span>
    </div>`;
}

function renderTeam(team, side, headerTeam, fcRatings) {
  const starters = getPlayers(team);
  const teamName = team?.name || headerTeam?.name ||
    (side === "home" ? "Home team" : "Away team");
  const crest = headerTeam?.imageUrl || team?.imageUrl || "";
  const formation = team?.formation || "";
  const playersHtml = starters.length
    ? starters.map(player => renderPlayer(player, side, fcRatings)).join("")
    : '<p class="lineup-empty">FotMob has not provided a starting lineup for this team yet.</p>';

  return `
    <section class="team-lineup">
      <div class="team-heading">
        ${crest ? `<img class="team-crest" src="${safeText(crest)}" alt="" loading="lazy">` : '<span class="team-crest-placeholder"></span>'}
        <div class="team-heading-copy"><h3>${safeText(teamName)}</h3><span>${safeText(formation || (starters.length ? "Starting lineup" : "Lineup unavailable"))}</span></div>
        <span class="player-count">${starters.length ? `${starters.length} players` : ""}</span>
      </div>
      <div class="player-list">${playersHtml}</div>
    </section>`;
}

function renderMatch(match, matchId) {
  const general = match?.general || {};
  const header = match?.header || {};
  const content = match?.content || {};
  const headerTeams = header.teams || [];
  const homeHeader = headerTeams[0] || general.homeTeam || {};
  const awayHeader = headerTeams[1] || general.awayTeam || {};
  const lineup = content.lineup || {};
  const home = getTeamLineup(lineup, "home", homeHeader.id || general.homeTeam?.id);
  const away = getTeamLineup(lineup, "away", awayHeader.id || general.awayTeam?.id);
  const homeName = homeHeader.name || home.name || "Home";
  const awayName = awayHeader.name || away.name || "Away";
  const status = header.status?.reason?.short || header.status?.liveTime?.short ||
    (header.status?.finished ? "FT" : header.status?.started ? "LIVE" : "UPCOMING");
  const competition = general.leagueName || "";
  const date = general.matchTimeUTCDate
    ? new Date(general.matchTimeUTCDate).toLocaleString(undefined, {
        dateStyle: "medium", timeStyle: "short"
      }) + " local"
    : "";
  const title = `${homeName} vs ${awayName}`;
  const homeTeam = { ...home, name: home.name || homeName };
  const awayTeam = { ...away, name: away.name || awayName };
  const hasLineup = getPlayers(homeTeam).length || getPlayers(awayTeam).length;

  currentMatch = currentMatch?.matchId === matchId
    ? { ...currentMatch, match, matchId }
    : { match, matchId, fcRatings: {}, fcRatingsLoaded: false };

  matchTitle.textContent = title;
  const fcRatings = currentMatch.fcRatings || {};

  matchContent.innerHTML = `
    <div class="match-summary">
      <div class="match-meta">${safeText(competition)}${competition && date ? " · " : ""}${safeText(date)}</div>
      <div class="scoreboard">
        <div class="score-team home-score"><span>${safeText(homeName)}</span><strong>${safeText(homeHeader.score ?? "–")}</strong></div>
        <div class="score-center"><strong>${safeText(status)}</strong></div>
        <div class="score-team away-score"><strong>${safeText(awayHeader.score ?? "–")}</strong><span>${safeText(awayName)}</span></div>
      </div>
      <div class="match-source">FotMob match ID <code>${safeText(matchId)}</code></div>
    </div>
    <div class="lineups-heading"><div><span class="stage-kicker">MATCH LINEUPS</span><h3>Starting XI</h3></div><span class="lineup-note">${hasLineup ? (ratingMode === "fc" ? "FC Database ratings" : "FotMob match ratings") : "Lineups may not be published yet"}</span></div>
    <div class="lineups-grid">
      ${renderTeam(homeTeam, "home", homeHeader, fcRatings)}
      ${renderTeam(awayTeam, "away", awayHeader, fcRatings)}
    </div>
    ${!hasLineup ? '<p class="lineup-footnote">The match details loaded successfully, but FotMob has not supplied the lineups in this response. Try again once lineups are available.</p>' : ""}
    <p class="rating-footnote">${ratingMode === "fc"
      ? (currentMatch.fcRatingsLoading
          ? "Looking up FC Database ratings from FCRadar..."
          : currentMatch.fcRatingsLoaded
            ? "FC Database ratings from FCRadar. A dash means no confident player match was found."
            : "Select FC Database to view player OVRs from FCRadar.")
      : "FotMob match ratings are displayed when available. Switch to FC Database to view player OVRs."}</p>
  `;

  matchContent.classList.remove("hidden");
  emptyState.classList.add("hidden");
}

async function loadFcRatings() {
  if (!currentMatch || currentMatch.fcRatingsLoaded || currentMatch.fcRatingsLoading) return;
  if (fcLookupPromise) return fcLookupPromise;
  if (!supabase) {
    setStatus("Supabase is not configured, so FC ratings cannot be loaded.", "error");
    return;
  }

  const matchRef = currentMatch;
  const players = collectPlayers(matchRef.match);
  if (!players.length) {
    setStatus("There are no starting players to look up.", "error");
    return;
  }

  currentMatch = { ...currentMatch, fcRatingsLoading: true };
  renderMatch(currentMatch.match, currentMatch.matchId);
  setStatus("Looking up FC Database ratings...", "loading");

  fcLookupPromise = (async () => {
    try {
      const { data, error } = await supabase.functions.invoke("match-companion", {
        body: { action: "ratings", players }
      });
      if (error) throw error;
      if (!data?.ok) throw new Error(data?.error || "FCRadar ratings could not be loaded.");
      if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;

      currentMatch = {
        ...currentMatch,
        fcRatings: data.ratings || {},
        fcRatingsLoaded: true,
        fcRatingsLoading: false,
      };
      renderMatch(currentMatch.match, currentMatch.matchId);
      const matched = Object.values(currentMatch.fcRatings).filter(item => item?.rating !== null && item?.rating !== undefined).length;
      setStatus(`FC Database ratings loaded: ${matched} of ${players.length} players matched.`, "success");
    } catch (error) {
      if (currentMatch?.matchId === matchRef.matchId) {
        currentMatch = { ...currentMatch, fcRatingsLoading: false };
        renderMatch(currentMatch.match, currentMatch.matchId);
      }
      setStatus(error.message || "Unable to load FC Database ratings.", "error");
    } finally {
      fcLookupPromise = null;
    }
  })();

  return fcLookupPromise;
}

function updateRatingMode() {
  if (!currentMatch) return;
  renderMatch(currentMatch.match, currentMatch.matchId);
  if (ratingMode === "fc") loadFcRatings();
}

modeButtons.forEach(button => button.addEventListener("click", () => {
  ratingMode = button.dataset.mode;
  modeButtons.forEach(item => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  updateRatingMode();
}));

form.addEventListener("submit", async event => {
  event.preventDefault();
  const matchId = matchIdFromUrl(urlInput.value.trim());
  if (!matchId) {
    setStatus("That link doesn't appear to contain a FotMob match ID. Open the match page and copy its full URL.", "error");
    return;
  }
  if (!supabase) {
    setStatus("One setup step remains: add your Supabase publishable key in config.js.", "error");
    return;
  }

  loadButton.disabled = true;
  loadButton.classList.add("loading");
  loadButton.querySelector("span").textContent = "Loading...";
  setStatus("Loading match details and lineups from FotMob...", "loading");

  try {
    const { data, error } = await supabase.functions.invoke("match-companion", {
      body: { action: "match", matchId }
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "The match could not be loaded.");
    if (!data.matchData) throw new Error("FotMob responded, but the match details were empty.");

    currentMatch = { match: data.matchData, matchId, fcRatings: {}, fcRatingsLoaded: false };
    renderMatch(data.matchData, matchId);
    setStatus("Match loaded successfully.", "success");
    if (ratingMode === "fc") loadFcRatings();
  } catch (error) {
    setStatus(error.message || "Something went wrong while loading the match.", "error");
  } finally {
    loadButton.disabled = false;
    loadButton.classList.remove("loading");
    loadButton.querySelector("span").textContent = "Load match";
  }
});
