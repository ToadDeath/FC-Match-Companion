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

function flattenPlayers(value) {
  if (!Array.isArray(value)) return [];
  return value.flat(Infinity).filter(player => player && typeof player === "object" && !Array.isArray(player));
}

function getPlayers(team) {
  return flattenPlayers(team?.starters || team?.players || []);
}

function getSubstitutes(team) {
  const explicit = flattenPlayers(team?.subs || team?.substitutes || []);
  if (explicit.length) return explicit;
  return flattenPlayers(team?.bench || []).filter(player =>
    player?.timeSubbedOn != null || player?.subbedOn != null || player?.substitutionMinute != null
  );
}

function getBenchPlayers(team, lineup, side, teamId) {
  let bench = team?.bench || team?.benchPlayers || [];
  if (!Array.isArray(bench) && bench && typeof bench === "object") {
    bench = bench.players || bench.bench || bench.substitutes || [];
  }
  if (Array.isArray(bench) && bench.length) return flattenPlayers(bench).filter(player =>
    player?.timeSubbedOn == null && player?.subbedOn == null && player?.substitutionMinute == null
  );

  const shared = lineup?.bench;
  if (Array.isArray(shared)) {
    const matching = shared.find(item =>
      String(item?.teamId ?? item?.id ?? "") === String(teamId ?? "") ||
      item?.side === side || item?.team === side
    );
    if (matching) return flattenPlayers(matching.players || matching.bench || matching.subs || []);
    return [];
  }
  if (shared && typeof shared === "object") {
    const sideData = shared[side] || shared[side === "home" ? "homeTeam" : "awayTeam"] ||
      shared[side === "home" ? "homePlayers" : "awayPlayers"];
    if (Array.isArray(sideData)) return flattenPlayers(sideData);
    if (sideData && typeof sideData === "object") return flattenPlayers(sideData.players || sideData.bench || []);
  }
  return [];
}

function getUnavailablePlayers(team, lineup, side, teamId) {
  let unavailable = team?.unavailable || team?.nonAvailablePlayers || team?.injured || [];
  if (Array.isArray(unavailable) && unavailable.length) return flattenPlayers(unavailable);
  const shared = lineup?.naPlayers || lineup?.unavailable || lineup?.nonAvailablePlayers;
  if (Array.isArray(shared)) {
    const matching = shared.find(item =>
      String(item?.teamId ?? item?.id ?? "") === String(teamId ?? "") ||
      item?.side === side || item?.team === side
    );
    return matching ? flattenPlayers(matching.players || matching.unavailable || matching.playersUnavailable || []) : [];
  }
  if (shared && typeof shared === "object") {
    const sideData = shared[side] || shared[side === "home" ? "homeTeam" : "awayTeam"] ||
      shared[side === "home" ? "homePlayers" : "awayPlayers"];
    if (Array.isArray(sideData)) return flattenPlayers(sideData);
    if (sideData && typeof sideData === "object") return flattenPlayers(sideData.players || sideData.unavailable || []);
  }
  return [];
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
  const collectTeamPlayers = (team, side, teamName, teamId) => [
    ...getPlayers(team),
    ...getSubstitutes(team),
    ...getBenchPlayers(team, lineup, side, teamId),
  ].map(player => ({
    key: playerKey(player, side),
    fotmobId: player?.id ?? player?.playerId ?? null,
    name: player?.name || player?.localizedName || "",
    position: player?.positionName || player?.position || player?.usualPosition || "",
    nationality: player?.nationality || player?.countryName || player?.country || player?.citizenship || "",
    team: teamName,
  }));
  return [
    ...collectTeamPlayers(home, "home", homeName, homeHeader.id || general.homeTeam?.id),
    ...collectTeamPlayers(away, "away", awayName, awayHeader.id || general.awayTeam?.id),
  ].filter(player => player.name);
}

function playerPhotoUrl(player) {
  const supplied = player?.imageUrl || player?.photoUrl || player?.image;
  if (typeof supplied === "string" && supplied.startsWith("https://") || typeof supplied === "string" && supplied.startsWith("http://")) return supplied;
  const id = player?.id ?? player?.playerId;
  return id ? "https://images.fotmob.com/image_resources/playerimages/" + encodeURIComponent(id) + ".png" : "";
}

function playerInitials(name) {
  return String(name || "?").trim().split(/\\s+/).slice(0, 2).map(part => part[0] || "").join("").toUpperCase();
}

function getPlayerPitchPositions(team, side) {
  const starters = getPlayers(team);
  const formation = String(team?.formation || "4-3-3");
  const lines = formation.split("-").map(value => Number.parseInt(value, 10)).filter(value => Number.isFinite(value) && value > 0);
  const formationRows = [1, ...lines];
  const positions = new Map();
  const hasHorizontal = starters.some(player => Number.isFinite(Number(player?.horizontalLayout?.x)) && Number.isFinite(Number(player?.horizontalLayout?.y)));
  if (hasHorizontal) {
    starters.forEach(player => {
      const layout = player?.horizontalLayout;
      if (!layout || !Number.isFinite(Number(layout.x)) || !Number.isFinite(Number(layout.y))) return;
      const rawX = Number(layout.x), rawY = Number(layout.y);
      const localX = Math.max(0, Math.min(1, rawX));
      const localY = Math.max(0, Math.min(1, rawY));
      const x = side === "home" ? 3 + localX * 45 : 97 - localX * 45;
      const y = 7 + localY * 86;
      positions.set(player, { x, y });
    });
  }
  if (positions.size < starters.length) {
    const rows = formationRows.map((count, index) => ({ count, index }));
    starters.forEach((player, playerIndex) => {
      if (positions.has(player)) return;
      let rowIndex = 0, colIndex = playerIndex;
      for (const row of rows) {
        if (colIndex < row.count) { rowIndex = row.index; break; }
        colIndex -= row.count;
        rowIndex = row.index + 1;
      }
      const count = rows[Math.min(rowIndex, rows.length - 1)]?.count || 1;
      const lineCount = rows.length;
      const localX = lineCount <= 1 ? .5 : .08 + (.84 * rowIndex / (lineCount - 1));
      const localY = count === 1 ? .5 : .12 + (.76 * colIndex / (count - 1));
      positions.set(player, {
        x: side === "home" ? 3 + localX * 45 : 97 - localX * 45,
        y: 7 + localY * 86
      });
    });
  }
  return starters.map((player, index) => ({ player, ...(positions.get(player) || { x: side === "home" ? 25 : 75, y: 50 }), index }));
}
function playerProfileUrl(player) {
  const id = player?.id ?? player?.playerId;
  if (id == null) return "";
  const name = player?.name || player?.localizedName || "";
  const slug = name.normalize("NFD").replace(/[\\u0300-\\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `https://www.fotmob.com/players/${encodeURIComponent(id)}/${slug}`;
}

function fcradarProfileLink(fcResult) {
  return fcResult?.fcradarUrl
    ? '<a class="player-provider-link" href="' + safeText(fcResult.fcradarUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Open FCRadar player profile" title="Open FCRadar profile">F</a>'
    : "";
}

function fotmobRatingClass(value) {
  if (value === "" || !Number.isFinite(Number(value))) return "rating-unavailable";
  const rating = Number(value);
  if (rating >= 9) return "rating-exceptional";
  if (rating >= 8) return "rating-elite";
  if (rating >= 7) return "rating-good";
  if (rating >= 6.5) return "rating-average";
  if (rating >= 6) return "rating-low";
  return "rating-poor";
}

function fcDatabaseRatingClass(value) {
  if (value === "" || !Number.isFinite(Number(value))) return "rating-unavailable";
  const rating = Number(value);
  if (rating >= 81 && rating <= 99) return "rating-fc-dark-green";
  if (rating >= 71 && rating <= 80) return "rating-fc-light-green";
  if (rating >= 61 && rating <= 70) return "rating-fc-yellow";
  if (rating >= 51 && rating <= 60) return "rating-fc-orange";
  if (rating >= 1 && rating <= 50) return "rating-fc-red";
  return "rating-unavailable";
}

function playerEventMarkup(player) {
  const minute = player?.timeSubbedOff ?? player?.subbedOff ?? player?.timeSubbedOn ??
    player?.subbedOn ?? player?.substitutionMinute ?? player?.eventMinute;
  const eventType = String(player?.eventType || player?.substitutionType || "").toLowerCase();
  if (minute == null || minute === "") return "";
  const label = String(minute).replace(/['’]$/, "") + "′";
  const icon = eventType.includes("red") ? "🟥" : eventType.includes("yellow") ? "🟨" :
    eventType.includes("sub") || player?.timeSubbedOff != null || player?.subbedOff != null ? "↔" : "";
  return '<span class="pitch-player-event">' + (icon ? '<i>' + icon + '</i>' : "") + safeText(label) + '</span>';
}

function renderPlayerBubble(player, side, fcRatings, position) {
  const name = player?.name || player?.localizedName || "Unknown player";
  const number = player?.shirtNumber ?? player?.number ?? player?.shirt ?? "";
  const key = playerKey(player, side), fcResult = fcRatings[key];
  const fcRating = fcResult?.rating === null || fcResult?.rating === undefined ? "" : String(fcResult.rating);
  const displayed = ratingMode === "fotmob" ? playerRating(player) : fcRating;
  const ratingTone = ratingMode === "fotmob" ? fotmobRatingClass(displayed) : fcDatabaseRatingClass(displayed);
  const photo = playerPhotoUrl(player);
  const photoMarkup = photo ? '<img class="player-face" src="' + safeText(photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' : "";
  const fallbackMarkup = '<span class="player-face-fallback" aria-hidden="true" ' + (photo ? "hidden" : "") + '></span>';
  const fotmobUrl = playerProfileUrl(player);
  const tag = fotmobUrl ? "a" : "div";
  const href = fotmobUrl ? ' href="' + safeText(fotmobUrl) + '" target="_blank" rel="noopener noreferrer" aria-label="Open ' + safeText(name) + ' on FotMob"' : "";
  return '<' + tag + ' class="pitch-player" style="--player-x:' + position.x + '%;--player-y:' + position.y + '%" title="' + safeText(name) + '"' + href + '>' +
    playerEventMarkup(player) +
    '<span class="pitch-player-portrait-row"><span class="player-face-wrap">' + photoMarkup + fallbackMarkup +
    (number !== "" ? '<span class="player-shirt-number">' + safeText(number) + "</span>" : "") + "</span>" +
    '<span class="pitch-player-rating ' + ratingTone + '">' + safeText(displayed || "—") + "</span></span>" +
    '<span class="pitch-player-name"><b>' + safeText(number) + '</b> ' + safeText(name) + "</span></' + tag + '>";
}

function renderRosterPlayer(player, side, fcRatings, kind) {
  const name = player?.name || player?.localizedName || "Unknown player";
  const number = player?.shirtNumber ?? player?.number ?? player?.shirt ?? "";
  const key = playerKey(player, side), fcResult = fcRatings[key];
  const fcRating = fcResult?.rating === null || fcResult?.rating === undefined ? "" : String(fcResult.rating);
  const displayed = ratingMode === "fotmob" ? playerRating(player) : fcRating;
  const ratingTone = ratingMode === "fotmob" ? fotmobRatingClass(displayed) : fcDatabaseRatingClass(displayed);
  const photo = playerPhotoUrl(player);
  const position = player?.positionName || player?.position || player?.usualPosition || "";
  const minute = player?.timeSubbedOn ?? player?.subbedOn ?? player?.substitutionMinute ?? "";
  const reason = player?.reason || player?.status || player?.injury || "";
  const detail = kind === "sub" && minute !== "" ? safeText(String(minute).replace(/['’]$/, "")) + "′" :
    kind === "unavailable" ? safeText(typeof reason === "object" ? reason.text || reason.name || reason.label || "" : reason) : "";
  const fotmobUrl = playerProfileUrl(player);
  const nameMarkup = fotmobUrl
    ? '<a class="roster-player-link" href="' + safeText(fotmobUrl) + '" target="_blank" rel="noopener noreferrer">' + safeText(name) + '</a>'
    : safeText(name);
  return '<div class="fc-roster-row fc-roster-row--' + kind + '">' +
    (photo ? '<img class="fc-roster-photo" src="' + safeText(photo) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="fc-roster-photo fc-roster-photo--empty"></span>') +
    '<span class="fc-roster-rating ' + ratingTone + '">' + safeText(displayed || "—") + "</span>" +
    '<span class="fc-roster-number">' + safeText(number || "·") + "</span>" +
    '<span class="fc-roster-copy"><strong>' + nameMarkup + fcradarProfileLink(fcResult) + '</strong><small>' + safeText(position) + (detail ? ' · ' + detail : "") + "</small></span></div>";
}

function renderRosterColumn(players, side, fcRatings, kind) {
  const rows = players.map(player => renderRosterPlayer(player, side, fcRatings, kind)).join("");
  return '<div class="fc-roster-list">' + (rows || '<p class="lineup-empty">None listed</p>') + '</div>';
}

function renderTeamPitchHeader(team, headerTeam, side) {
  const name = team?.name || headerTeam?.name || (side === "home" ? "Home" : "Away");
  const crest = headerTeam?.imageUrl || team?.imageUrl || "";
  const rating = team?.rating ?? team?.averageRating ?? "";
  const ratingTone = rating !== "" && Number(rating) >= 7 ? "rating-good" : rating !== "" ? "rating-low" : "";
  return '<div class="pitch-team-label ' + side + '">' +
    (side === "home" && rating !== "" ? '<span class="team-average-rating ' + ratingTone + '">' + safeText(rating) + '</span>' : "") +
    (crest ? '<img src="' + safeText(crest) + '" alt="" loading="lazy">' : "") +
    '<span>' + safeText(name) + '</span><small>' + safeText(team?.formation || "") + '</small>' +
    (side === "away" && rating !== "" ? '<span class="team-average-rating ' + ratingTone + '">' + safeText(rating) + '</span>' : "") + '</div>';
}

function renderCombinedPitch(home, away, homeHeader, awayHeader, fcRatings) {
  const players = [
    ...getPlayerPitchPositions(home, "home").map(item => renderPlayerBubble(item.player, "home", fcRatings, item)),
    ...getPlayerPitchPositions(away, "away").map(item => renderPlayerBubble(item.player, "away", fcRatings, item))
  ].join("");
  return '<div class="combined-pitch-card"><div class="combined-pitch-headings">' +
    renderTeamPitchHeader(home, homeHeader, "home") + renderTeamPitchHeader(away, awayHeader, "away") +
    '</div><div class="combined-pitch" aria-label="Both starting lineups on one football pitch">' +
    '<div class="pitch-boundary"></div><div class="pitch-halfway"></div><div class="pitch-center-circle"></div><div class="pitch-center-spot"></div>' +
    '<div class="pitch-box-left"></div><div class="pitch-box-right"></div><div class="pitch-six-left"></div><div class="pitch-six-right"></div>' + players + "</div></div>";
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
  const homeBench = getBenchPlayers(homeTeam, lineup, "home", homeHeader.id || general.homeTeam?.id);
  const awayBench = getBenchPlayers(awayTeam, lineup, "away", awayHeader.id || general.awayTeam?.id);
  const homeUnavailable = getUnavailablePlayers(homeTeam, lineup, "home", homeHeader.id || general.homeTeam?.id);
  const awayUnavailable = getUnavailablePlayers(awayTeam, lineup, "away", awayHeader.id || general.awayTeam?.id);
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
    <div class="lineup-display">
      ${renderCombinedPitch(homeTeam, awayTeam, homeHeader, awayHeader, fcRatings)}
      <div class="fc-roster-groups">
        <section class="fc-roster-group"><div class="fc-roster-heading">Substitutes</div><div class="fc-roster-columns">
          ${renderRosterColumn(getSubstitutes(homeTeam), "home", fcRatings, "sub")}
          ${renderRosterColumn(getSubstitutes(awayTeam), "away", fcRatings, "sub")}
        </div></section>
        ${homeBench.length || awayBench.length ? `<section class="fc-roster-group"><div class="fc-roster-heading">Bench</div><div class="fc-roster-columns">
          ${renderRosterColumn(homeBench, "home", fcRatings, "bench")}
          ${renderRosterColumn(awayBench, "away", fcRatings, "bench")}
        </div></section>` : ""}
        ${homeUnavailable.length || awayUnavailable.length ? `<section class="fc-roster-group"><div class="fc-roster-heading">Injured and suspended players</div><div class="fc-roster-columns">
          ${renderRosterColumn(homeUnavailable, "home", fcRatings, "unavailable")}
          ${renderRosterColumn(awayUnavailable, "away", fcRatings, "unavailable")}
        </div></section>` : ""}
      </div>
    </div>
    ${!hasLineup ? '<p class="lineup-footnote">The match details loaded successfully, but FotMob has not supplied the lineups in this response. Try again once lineups are available.</p>' : ""}
    ${currentMatch.fcRatingsLoading ? (() => {
      const progress = currentMatch.fcRatingsProgress || { matched: 0, total: lookupPlayers.length };
      return `<div class="fc-lookup-progress" role="status" aria-live="polite">
        <div class="fc-lookup-progress-top"><span class="fc-lookup-spinner" aria-hidden="true"></span>
          <span><strong>Matching players to FC Database</strong><small>${safeText(currentMatch.fcRatingsStage || "Checking saved ratings.")}</small></span>
          <b class="fc-lookup-count">${progress.matched}/${progress.total}</b>
        </div>
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
    fcRatingsProgress: { matched: 0, total: players.length },
  };
  renderMatch(currentMatch.match, currentMatch.matchId);
  setStatus("Matching players to the FC Database...", "loading");

  const lookupMatchId = matchRef.matchId;
  const lookupPromise = (async () => {
    try {
      // Load valid cached ratings in one bulk request, then resolve only misses
      // in small concurrent batches so the progress indicator reflects real work.
      const { data: cacheData, error: cacheError } = await supabase.functions.invoke("match-companion", {
        body: { action: "ratings-cache", players }
      });
      if (cacheError) throw cacheError;
      if (!cacheData?.ok) throw new Error(cacheData?.error || "Saved FC Database ratings could not be loaded.");
      if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;

      const combinedRatings = { ...(currentMatch.fcRatings || {}), ...(cacheData.ratings || {}) };
      const missingKeys = new Set(cacheData.missingKeys || []);
      const missingPlayers = players.filter(player => missingKeys.has(player.key));
      const cachedCount = players.filter(player => combinedRatings[player.key]?.rating !== null && combinedRatings[player.key]?.rating !== undefined).length;
      const batchSize = 8;
      const totalBatches = Math.ceil(missingPlayers.length / batchSize);

      currentMatch = {
        ...currentMatch,
        fcRatings: { ...combinedRatings },
        fcRatingsProgress: { matched: cachedCount, total: players.length },
        fcRatingsStage: missingPlayers.length
          ? `${cachedCount}/${players.length} matched so far. Resolving ${missingPlayers.length} uncached players.`
          : "All ratings loaded from the saved cache.",
      };
      renderMatch(currentMatch.match, currentMatch.matchId);
      setStatus(`FC Database: ${cachedCount}/${players.length} players matched. Continuing...`, "loading");

      for (let offset = 0; offset < missingPlayers.length; offset += batchSize) {
        const batch = missingPlayers.slice(offset, offset + batchSize);
        const batchNumber = Math.floor(offset / batchSize) + 1;
        currentMatch = {
          ...currentMatch,
          fcRatingsStage: `Resolving uncached players - batch ${batchNumber} of ${totalBatches}.`,
        };
        renderMatch(currentMatch.match, currentMatch.matchId);

        const { data, error } = await supabase.functions.invoke("match-companion", {
          body: { action: "ratings-resolve", players: batch }
        });
        if (error) throw error;
        if (!data?.ok) throw new Error(data?.error || "Uncached FC Database ratings could not be resolved.");
        if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;

        Object.assign(combinedRatings, data.ratings || {});
        const matched = players.filter(player =>
          combinedRatings[player.key]?.rating !== null && combinedRatings[player.key]?.rating !== undefined
        ).length;
        currentMatch = {
          ...currentMatch,
          fcRatings: { ...combinedRatings },
          fcRatingsProgress: { matched, total: players.length },
          fcRatingsStage: `${matched}/${players.length} matched so far.`,
        };
        renderMatch(currentMatch.match, currentMatch.matchId);
        setStatus(`FC Database: ${matched}/${players.length} players matched. Continuing...`, "loading");
      }

      currentMatch = {
        ...currentMatch,
        fcRatings: combinedRatings,
        fcRatingsProgress: { matched: players.filter(player => combinedRatings[player.key]?.rating !== null && combinedRatings[player.key]?.rating !== undefined).length, total: players.length },
        fcRatingsStage: "All players checked.",
      };
      renderMatch(currentMatch.match, currentMatch.matchId);

      if (!currentMatch || currentMatch.matchId !== matchRef.matchId) return;
      currentMatch = {
        ...currentMatch,
        fcRatings: combinedRatings,
        fcRatingsLoaded: true,
        fcRatingsLoading: false,
        fcRatingsProgress: { matched: players.filter(player => combinedRatings[player.key]?.rating !== null && combinedRatings[player.key]?.rating !== undefined).length, total: players.length },
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
    setStatus("Matching players to the FC Database...", "loading");
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
