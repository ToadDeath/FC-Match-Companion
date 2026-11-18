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

function getSubstitutes(team) {
  const substitutes = team?.subs || team?.substitutes || team?.bench || [];
  return Array.isArray(substitutes) ? substitutes : [];
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
  const collectTeamPlayers = (team, side, teamName) => [
    ...getPlayers(team),
    ...getSubstitutes(team),
  ].map(player => ({
    key: playerKey(player, side),
    fotmobId: player?.id ?? player?.playerId ?? null,
    name: player?.name || player?.localizedName || "",
    position: player?.positionName || player?.position || player?.usualPosition || "",
    team: teamName,
  }));
  return [
    ...collectTeamPlayers(home, "home", homeName),
    ...collectTeamPlayers(away, "away", awayName),
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
  const substitutes = getSubstitutes(team);
  const teamName = team?.name || headerTeam?.name ||
    (side === "home" ? "Home team" : "Away team");
  const crest = headerTeam?.imageUrl || team?.imageUrl || "";
  const formation = team?.formation || "";
  const startersHtml = starters.length
    ? starters.map(player => renderPlayer(player, side, fcRatings)).join("")
    : '<p class="lineup-empty">FotMob has not provided a starting lineup for this team yet.</p>';
  const substitutesHtml = substitutes.length
    ? substitutes.map(player => renderPlayer(player, side, fcRatings)).join("")
    : '<p class="lineup-empty">FotMob has not provided the substitutes for this team yet.</p>';

  return `
    <section class="team-lineup">
      <div class="team-heading">
        ${crest ? `<img class="team-crest" src="${safeText(crest)}" alt="" loading="lazy">` : '<span class="team-crest-placeholder"></span>'}
        <div class="team-heading-copy"><h3>${safeText(teamName)}</h3><span>${safeText(formation || (starters.length ? "Starting lineup" : "Lineup unavailable"))}</span></div>
        <span class="player-count">${starters.length} starters · ${substitutes.length} subs</span>
      </div>
      <div class="player-list">${startersHtml}</div>
      <div class="player-section-heading">SUBSTITUTES</div>
      <div class="player-list">${substitutesHtml}</div>
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
  const hasLineup = getPlayers(homeTeam).length || getSubstitutes(homeTeam).length ||
    getPlayers(awayTeam).length || getSubstitutes(awayTeam).length;

  currentMatch = currentMatch?.matchId === matchId
    ? { ...currentMatch, match, matchId }
    : { match, matchId, fcRatings: {}, fcRatingsLoaded: false };

  matchTitle.textContent = title;
  const fcRatings = currentMatch.fcRatings || {};
  const lookupPlayers = collectPlayers(match);
  const unmatchedPlayers = currentMatch.fcRatingsLoaded
    ? lookupPlayers.filter(player => {
        const result = fcRatings[player.key];
        return !result || result.rating === null || result.rating === undefined;
      })
    : [];
  const unmatchedSummary = unmatchedPlayers.length
    ? `Not matched: ${unmatchedPlayers.map(player => {
        const result = fcRatings[player.key];
        return `${player.name}${result?.status === "ambiguous" ? " (ambiguous match)" : ""}`;
      }).join(", ")}.`
    : "";
  const candidateDiagnosticsHtml = unmatchedPlayers.map(player => {
    const result = fcRatings[player.key];
    const suggestions = result?.suggestions || [];
    const fotmobSlug = player.name.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    const fotmobUrl = player.fotmobId
      ? `https://www.fotmob.com/players/${encodeURIComponent(player.fotmobId)}/${fotmobSlug}`
      : "";
    return `<details class="candidate-diagnostics">
      <summary>Inspect FCRadar search for ${safeText(player.name)} (${suggestions.length} candidates)</summary>
      <div class="candidate-diagnostics-links">${fotmobUrl ? `<a href="${fotmobUrl}" target="_blank" rel="noopener noreferrer">Open FotMob profile</a>` : ""}</div>
      ${suggestions.length ? suggestions.map(candidate => `<div class="candidate-diagnostic-row">
        <span><strong>${safeText(candidate.name)}</strong><small>${safeText(candidate.club || "Club unavailable")} · ${safeText(candidate.position || "Position unavailable")}${candidate.rating ? ` · ${candidate.rating} OVR` : ""}</small></span>
        <a href="${safeText(candidate.url)}" target="_blank" rel="noopener noreferrer">FCRadar ↗</a>
      </div>`).join("") : '<p class="candidate-diagnostics-empty">FCRadar returned no candidate records for the searches attempted. This points to a search/query or response-parsing issue rather than a confirmed absence from the game.</p>'}
    </details>`;
  }).join("");

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
    ${currentMatch.fcRatingsLoading ? (() => {
      const progress = currentMatch.fcRatingsProgress || { completed: 0, total: lookupPlayers.length };
      const percent = progress.total ? Math.round(progress.completed / progress.total * 100) : 0;
      return `<div class="fc-lookup-progress" role="status" aria-live="polite">
        <div class="fc-lookup-progress-top"><span class="fc-lookup-spinner" aria-hidden="true"></span>
          <span><strong>Matching players to FC Database</strong><small>${progress.completed} of ${progress.total} players checked. ${safeText(currentMatch.fcRatingsStage || "Checking saved ratings.")}</small></span>
          <b>${percent}%</b>
        </div>
        <div class="fc-lookup-progress-track"><span style="width:${percent}%"></span></div>
      </div>`;
    })() : ""}
    <p class="rating-footnote">${currentMatch.fcRatingsLoaded
      ? `FC Database: ${lookupPlayers.length - unmatchedPlayers.length}/${lookupPlayers.length} players matched. ${safeText(unmatchedSummary)}`
      : ratingMode === "fc"
        ? "FC Database ratings are retrieved from FCRadar."
        : "FotMob match ratings are displayed by default. FC Database ratings are prepared in the background."}</p>
    ${currentMatch.fcRatingsLoaded ? candidateDiagnosticsHtml : ""}
  `;

  matchContent.classList.remove("hidden");
  emptyState.classList.add("hidden");
}

async function loadFcRatings() {
  if (!currentMatch || currentMatch.fcRatingsLoaded || currentMatch.fcRatingsLoading) return;
  if (fcLookupPromise?.matchId === currentMatch.matchId) return fcLookupPromise.promise;
  if (!supabase) {
    setStatus("Supabase is not configured, so FC ratings cannot be loaded.", "error");
    return;
  }

  const matchRef = currentMatch;
  const players = collectPlayers(matchRef.match);
  if (!players.length) {
    setStatus("There are no lineup players to look up.", "error");
    return;
  }

  currentMatch = {
    ...currentMatch,
    fcRatingsLoading: true,
    fcRatingsProgress: { completed: 0, total: players.length },
  };
  renderMatch(currentMatch.match, currentMatch.matchId);
  if (ratingMode === "fc") setStatus("Matching players to the FC Database...", "loading");

  const lookupMatchId = matchRef.matchId;
  const lookupPromise = (async () => {
    try {
      // First retrieve all valid cached OVRs in one quick request. This lets
      // known players appear immediately while only cache misses are resolved.
      const { data: cacheData, error: cacheError } = await supabase.functions.invoke("match-companion", {
        body: { action: "ratings-cache", players }
      });
      if (cacheError) throw cacheError;
      if (!cacheData?.ok) throw new Error(cacheData?.error || "Saved FC Database ratings could not be loaded.");
      if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;

      const combinedRatings = { ...(currentMatch.fcRatings || {}), ...(cacheData.ratings || {}) };
      const missingKeys = new Set(cacheData.missingKeys || []);
      const missingPlayers = players.filter(player => missingKeys.has(player.key));
      const cachedCount = players.length - missingPlayers.length;

      currentMatch = {
        ...currentMatch,
        fcRatings: { ...combinedRatings },
        fcRatingsProgress: { completed: cachedCount, total: players.length },
        fcRatingsStage: missingPlayers.length
          ? `${cachedCount} saved ratings loaded. Resolving ${missingPlayers.length} players not yet cached.`
          : "All ratings loaded from the saved cache.",
      };
      renderMatch(currentMatch.match, currentMatch.matchId);
      setStatus(
        missingPlayers.length
          ? `FC Database: ${cachedCount} of ${players.length} ratings loaded from cache. Resolving the rest...`
          : `FC Database: all ${players.length} ratings loaded from cache.`,
        "loading"
      );

      if (missingPlayers.length) {
        const { data, error } = await supabase.functions.invoke("match-companion", {
          body: { action: "ratings", players: missingPlayers }
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error || "Uncached FC Database ratings could not be resolved.");
        if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;

        Object.assign(combinedRatings, data.ratings || {});
      }

      currentMatch = {
        ...currentMatch,
        fcRatings: combinedRatings,
        fcRatingsProgress: { completed: players.length, total: players.length },
        fcRatingsStage: "All players checked.",
      };
      renderMatch(currentMatch.match, currentMatch.matchId);

      if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;
      currentMatch = {
        ...currentMatch,
        fcRatings: combinedRatings,
        fcRatingsLoaded: true,
        fcRatingsLoading: false,
        fcRatingsProgress: { completed: players.length, total: players.length },
      };
      renderMatch(currentMatch.match, currentMatch.matchId);
      const matched = Object.values(combinedRatings)
        .filter(item => item?.rating !== null && item?.rating !== undefined).length;
      setStatus(`FC Database matching complete: ${matched} of ${players.length} players matched.`, "success");
    } catch (error) {
      if (currentMatch?.matchId === matchRef.matchId) {
        currentMatch = { ...currentMatch, fcRatingsLoading: false, fcRatingsError: error.message };
        renderMatch(currentMatch.match, currentMatch.matchId);
      }
      setStatus(error.message || "Unable to load FC Database ratings.", "error");
    } finally {
      if (fcLookupPromise?.matchId === lookupMatchId) fcLookupPromise = null;
    }
  })();

  fcLookupPromise = { matchId: lookupMatchId, promise: lookupPromise };
  return lookupPromise;
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
    // Prefetch FC Database ratings as soon as the match lineups are available,
    // even while FotMob remains the selected display mode.
    loadFcRatings();
  } catch (error) {
    setStatus(error.message || "Something went wrong while loading the match.", "error");
  } finally {
    loadButton.disabled = false;
    loadButton.classList.remove("loading");
    loadButton.querySelector("span").textContent = "Load match";
  }
});
