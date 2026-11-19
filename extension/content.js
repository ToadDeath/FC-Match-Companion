(() => {
  "use strict";

  const config = window.__FC_MATCH_COMPANION_CONFIG__ || {};
  const supabaseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const publishableKey = String(config.supabasePublishableKey || "");
  const savedPills = new Map();
  const injectedPills = new Map();
  const ratingByFotMobId = new Map();
  let activeMode = "fotmob";
  let activeMatchId = "";
  let loadSequence = 0;
  let observerTimer = 0;
  let lastApplySignature = "";

  const PLAYER_LINK = /\/players\/(\d+)(?:\/|$)/;
  const MATCH_ID = /(?:^#|[#:])(?:[^0-9]*)(\d{5,})/;

  function getMatchId() {
    const hashMatch = location.hash.match(MATCH_ID);
    if (hashMatch) return hashMatch[1];
    const query = new URL(location.href).searchParams.get("matchId");
    return query && /^\d{5,}$/.test(query) ? query : "";
  }

  function getOrCreateUi() {
    let toggle = document.getElementById("fc-match-companion-toggle");
    if (!toggle) {
      toggle = document.createElement("div");
      toggle.id = "fc-match-companion-toggle";
      toggle.setAttribute("role", "group");
      toggle.setAttribute("aria-label", "Rating display");
      toggle.innerHTML =
        '<button type="button" data-mode="fotmob" aria-pressed="true">FotMob</button>' +
        '<button type="button" data-mode="fc" aria-pressed="false">FC Database</button>';
      toggle.addEventListener("click", event => {
        const button = event.target.closest("button[data-mode]");
        if (!button) return;
        setMode(button.dataset.mode);
      });
      placeToggle(toggle);
    }

    let status = document.getElementById("fc-match-companion-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "fc-match-companion-status";
      status.hidden = true;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      placeStatus(status);
    }
    return { toggle, status };
  }

  function findLineupHeading() {
    const headings = [...document.querySelectorAll("h1,h2,h3,h4,[role='heading']")];
    return headings.find(node => /^(line.?ups?|starting\s*xi|lineup)$/i.test((node.textContent || "").trim()));
  }

  function placeToggle(toggle) {
    const heading = findLineupHeading();
    if (heading?.parentElement) {
      if (toggle.parentElement !== heading.parentElement.parentElement ||
          toggle.previousElementSibling !== heading.parentElement) {
        heading.parentElement.insertAdjacentElement("afterend", toggle);
      }
    } else if (document.body && toggle.parentElement !== document.body) {
      document.body.insertAdjacentElement("afterbegin", toggle);
    }
  }

  function placeStatus(status) {
    const toggle = document.getElementById("fc-match-companion-toggle");
    if (toggle?.parentElement && status.previousElementSibling !== toggle) toggle.insertAdjacentElement("afterend", status);
    else if (!toggle && document.body && status.parentElement !== document.body) document.body.insertAdjacentElement("afterbegin", status);
  }

  function setStatus(message, visible = true) {
    const { status } = getOrCreateUi();
    status.textContent = message;
    status.hidden = !visible || !message;
  }

  function updateToggle() {
    const { toggle } = getOrCreateUi();
    toggle.querySelectorAll("button[data-mode]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.mode === activeMode));
    });
  }

  function setMode(mode) {
    if (mode !== "fotmob" && mode !== "fc") return;
    activeMode = mode;
    updateToggle();
    if (activeMode === "fotmob") {
      restoreFotMobRatings();
      setStatus("", false);
    } else if (ratingByFotMobId.size) {
      applyDatabaseRatings();
    } else if (activeMatchId) {
      setStatus("Loading FC Database OVRs...");
      loadMatchRatings(activeMatchId);
    } else {
      setStatus("Open a FotMob match with a loaded lineup to use FC Database ratings.");
    }
  }

  async function invoke(action, payload = {}) {
    if (!supabaseUrl || !publishableKey) {
      throw new Error("The extension's Supabase configuration is missing.");
    }
    const response = await fetch(supabaseUrl + "/functions/v1/match-companion", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "apikey": publishableKey,
        "Authorization": "Bearer " + publishableKey
      },
      body: JSON.stringify({ action, ...payload })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      throw new Error(data.error || "The FC Database request failed (HTTP " + response.status + ").");
    }
    return data;
  }

  function flattenPlayers(value) {
    if (!Array.isArray(value)) return [];
    return value.flat(Infinity).filter(player =>
      player && typeof player === "object" && !Array.isArray(player)
    );
  }

  function teamLineup(lineup, side, teamId) {
    const named = lineup && lineup[side === "home" ? "homeTeam" : "awayTeam"];
    if (named) return named;
    const list = Array.isArray(lineup && lineup.lineup) ? lineup.lineup : [];
    return list.find(team => String(team.id ?? team.teamId) === String(teamId)) ||
      list[side === "home" ? 0 : 1] || {};
  }

  function teamPlayers(team) {
    const starters = flattenPlayers(team.starters || team.players || []);
    const explicitSubs = flattenPlayers(team.subs || team.substitutes || []);
    const subs = explicitSubs.length ? explicitSubs : flattenPlayers(team.bench || []).filter(player =>
      player.timeSubbedOn != null || player.subbedOn != null || player.substitutionMinute != null
    );
    let bench = team.bench || team.benchPlayers || [];
    if (!Array.isArray(bench) && bench && typeof bench === "object") {
      bench = bench.players || bench.bench || bench.substitutes || [];
    }
    const unusedBench = flattenPlayers(bench).filter(player =>
      player.timeSubbedOn == null && player.subbedOn == null && player.substitutionMinute == null
    );
    return [...starters, ...subs, ...unusedBench];
  }

  function collectRatingRequests(match) {
    const general = match.general || {};
    const headers = match.header?.teams || [];
    const homeHeader = headers[0] || general.homeTeam || {};
    const awayHeader = headers[1] || general.awayTeam || {};
    const lineup = match.content?.lineup || {};
    const teams = [
      { side: "home", header: homeHeader },
      { side: "away", header: awayHeader }
    ];
    const requests = [];
    const seen = new Set();

    for (const item of teams) {
      const team = teamLineup(lineup, item.side, item.header.id || (item.side === "home" ? general.homeTeam?.id : general.awayTeam?.id));
      const teamName = item.header.name || team.name || "";
      for (const player of teamPlayers(team)) {
        const id = player.id ?? player.playerId;
        const name = player.name || player.localizedName || "";
        if (id == null || !name) continue;
        const key = item.side + ":" + id + ":" + name;
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push({
          key,
          fotmobId: id,
          name,
          position: player.positionName || player.position || player.usualPosition || "",
          nationality: player.nationality || player.countryName || player.country || player.citizenship || "",
          team: teamName
        });
      }
    }
    return requests.slice(0, 60);
  }

  async function loadMatchRatings(matchId) {
    const sequence = ++loadSequence;
    activeMatchId = matchId;
    ratingByFotMobId.clear();
    lastApplySignature = "";
    if (activeMode === "fc") setStatus("Loading match lineup and FC Database OVRs...");

    try {
      const matchResponse = await invoke("match", { matchId });
      if (sequence !== loadSequence || matchId !== getMatchId()) return;
      const players = collectRatingRequests(matchResponse.matchData || {});
      if (!players.length) {
        if (activeMode === "fc") setStatus("FotMob has not exposed a lineup for this match yet.");
        return;
      }

      const ratingResponse = await invoke("ratings", { players });
      if (sequence !== loadSequence || matchId !== getMatchId()) return;

      for (const player of players) {
        const result = ratingResponse.ratings?.[player.key];
        ratingByFotMobId.set(String(player.fotmobId), {
          rating: result?.rating == null ? null : Number(result.rating),
          status: result?.status || "not_found",
          fcradarUrl: result?.fcradarUrl || ""
        });
      }

      const matched = [...ratingByFotMobId.values()].filter(result => result.rating != null).length;
      if (activeMode === "fc") {
        applyDatabaseRatings();
        setStatus("FC Database: " + matched + "/" + players.length + " players matched.");
      }
    } catch (error) {
      console.error("[FC Match Companion]", error);
      if (activeMode === "fc") setStatus(error.message || "Unable to load FC Database OVRs.");
    }
  }

  function findRatingPill(playerAnchor) {
    let current = playerAnchor;
    for (let level = 0; current && level < 8; level++, current = current.parentElement) {
      const candidates = [...current.querySelectorAll("span, div, strong, b")]
        .filter(node => {
          if (node.closest("#fc-match-companion-toggle, #fc-match-companion-status")) return false;
          const text = (node.textContent || "").trim();
          if (!/^\d{1,2}(?:\.\d)?$/.test(text)) return false;
          if (node.children.length > 0) return false;
          const classes = String(node.className || "").toLowerCase();
          const ratingClass = /rating|score|performance|pill/.test(classes);
          const decimalRating = /^\d{1,2}\.\d$/.test(text) && Number(text) >= 1 && Number(text) <= 10;
          return ratingClass || decimalRating;
        });
      if (candidates.length) {
        candidates.sort((a, b) => {
          const aClass = /rating|score|performance|pill/i.test(String(a.className || "")) ? 0 : 1;
          const bClass = /rating|score|performance|pill/i.test(String(b.className || "")) ? 0 : 1;
          return aClass - bClass;
        });
        return candidates[0];
      }
    }
    return null;
  }

  function rememberOriginal(node) {
    if (savedPills.has(node)) return;
    savedPills.set(node, {
      text: node.textContent,
      className: node.getAttribute("class"),
      style: node.getAttribute("style"),
      title: node.getAttribute("title"),
      ariaLabel: node.getAttribute("aria-label")
    });
  }

  function toneForRating(value) {
    if (value == null || !Number.isFinite(Number(value))) return "fcdb-ovr-none";
    const rating = Number(value);
    if (rating >= 81) return "fcdb-ovr-elite";
    if (rating >= 71) return "fcdb-ovr-high";
    if (rating >= 61) return "fcdb-ovr-mid";
    if (rating >= 51) return "fcdb-ovr-low";
    if (rating >= 1) return "fcdb-ovr-poor";
    return "fcdb-ovr-none";
  }

  function createInjectedPill(anchor, playerId, result) {
    let pill = injectedPills.get(playerId);
    if (!pill || !pill.isConnected) {
      pill = result.fcradarUrl ? document.createElement("a") : document.createElement("span");
      pill.className = "fcdb-rating-pill fcdb-injected-rating";
      pill.dataset.fcdbPlayerId = playerId;
      if (result.fcradarUrl) {
        pill.href = result.fcradarUrl;
        pill.target = "_blank";
        pill.rel = "noopener noreferrer";
        pill.title = "Open this player on FCRadar";
        pill.setAttribute("aria-label", "FC Database OVR. Open FCRadar player profile");
      }
      anchor.insertAdjacentElement("afterend", pill);
      injectedPills.set(playerId, pill);
    }
    pill.textContent = result.rating == null ? "—" : String(result.rating);
    pill.className = "fcdb-rating-pill fcdb-injected-rating " + toneForRating(result.rating);
    pill.hidden = false;
    return pill;
  }

  function applyDatabaseRatings() {
    if (activeMode !== "fc" || !ratingByFotMobId.size) return;
    const anchors = [...document.querySelectorAll('a[href*="/players/"]')];
    let updated = 0;
    const seenIds = new Set();

    for (const anchor of anchors) {
      const match = (anchor.getAttribute("href") || "").match(PLAYER_LINK);
      if (!match) continue;
      const playerId = match[1];
      if (seenIds.has(playerId)) continue;
      seenIds.add(playerId);
      const result = ratingByFotMobId.get(playerId);
      if (!result) continue;

      const nativePill = findRatingPill(anchor);
      if (nativePill) {
        rememberOriginal(nativePill);
        nativePill.hidden = true;
      }
      createInjectedPill(anchor, playerId, result);
      updated++;
    }

    const signature = activeMatchId + ":" + updated + ":" + anchors.length;
    if (signature !== lastApplySignature) {
      lastApplySignature = signature;
      if (!updated) setStatus("FC Database ratings are loaded. Waiting for FotMob's lineup players to appear...");
      else setStatus("FC Database: " + [...ratingByFotMobId.values()].filter(result => result.rating != null).length +
        "/" + ratingByFotMobId.size + " players matched.");
    }
  }

  function restoreFotMobRatings() {
    for (const [node, original] of savedPills) {
      if (!node.isConnected) continue;
      node.textContent = original.text;
      if (original.className == null) node.removeAttribute("class");
      else node.setAttribute("class", original.className);
      if (original.style == null) node.removeAttribute("style");
      else node.setAttribute("style", original.style);
      if (original.title == null) node.removeAttribute("title");
      else node.setAttribute("title", original.title);
      if (original.ariaLabel == null) node.removeAttribute("aria-label");
      else node.setAttribute("aria-label", original.ariaLabel);
    }
    savedPills.clear();
    for (const pill of injectedPills.values()) { if (pill.isConnected) pill.remove(); }
    injectedPills.clear();
    lastApplySignature = "";
  }

  function handleRouteChange() {
    getOrCreateUi();
    const matchId = getMatchId();
    if (matchId && matchId !== activeMatchId) {
      restoreFotMobRatings();
      ratingByFotMobId.clear();
      activeMatchId = matchId;
      if (activeMode === "fc") setStatus("Loading FC Database OVRs...");
      loadMatchRatings(matchId);
    } else if (!matchId && activeMatchId) {
      restoreFotMobRatings();
      ratingByFotMobId.clear();
      activeMatchId = "";
      loadSequence++;
      if (activeMode === "fc") setStatus("Open a FotMob match to load FC Database OVRs.");
    }
  }

  function scheduleDomRefresh() {
    if (observerTimer) clearTimeout(observerTimer);
    observerTimer = setTimeout(() => {
      observerTimer = 0;
      const toggle = document.getElementById("fc-match-companion-toggle");
      const status = document.getElementById("fc-match-companion-status");
      if (toggle) placeToggle(toggle);
      if (status) placeStatus(status);
      if (activeMode === "fc") applyDatabaseRatings();
    }, 180);
  }

  function start() {
    const { toggle } = getOrCreateUi();
    placeToggle(toggle);
    updateToggle();
    const matchId = getMatchId();
    if (matchId) {
      activeMatchId = matchId;
      loadMatchRatings(matchId);
    }
    const observer = new MutationObserver(mutations => {
      if (mutations.some(mutation => {
        const target = mutation.target;
        return !(target instanceof Element && target.closest("#fc-match-companion-toggle, #fc-match-companion-status"));
      })) scheduleDomRefresh();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    window.addEventListener("hashchange", handleRouteChange);
    window.addEventListener("popstate", handleRouteChange);
    window.addEventListener("pageshow", handleRouteChange);
    setInterval(handleRouteChange, 900);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();