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

  const PLAYER_LINK = /\/players\/(\d+)(?=[/?#]|$)/;
  const TONE_CLASSES = ["fcdb-ovr-elite", "fcdb-ovr-high", "fcdb-ovr-mid", "fcdb-ovr-low", "fcdb-ovr-poor", "fcdb-ovr-none"];
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
      toggle.type = "button";
      toggle.textContent = "FC Database";
      toggle.setAttribute("aria-label", "Toggle FC Database ratings");
      toggle.setAttribute("aria-pressed", "false");
      toggle.addEventListener("click", () => {
        setMode(activeMode === "fc" ? "fotmob" : "fc");
      });
      placeToggle(toggle);
    }

    let status = document.getElementById("fc-match-companion-status");
    if (!status) {
      status = document.createElement("div");
      status.id = "fc-match-companion-status";
      status.textContent = "Extension active - open a FotMob match to load ratings.";
      status.hidden = false;
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      placeStatus(status);
    }
    return { toggle, status };
  }

  function placeToggle(toggle) {
    // Put the toggle alongside FotMob's native lineup filters. FotMob can
    // replace this row during SPA navigation, so the observer rehomes it.
    const filterRow = document.querySelector('[class*="FilterButtons"][class*="LineupFilterButtons"]') ||
      document.querySelector('[class*="LineupFilterWrapper"]');
    if (filterRow && toggle.parentElement !== filterRow) {
      const referenceButton = filterRow.querySelector("button");
      if (referenceButton) toggle.className = referenceButton.className + " fcdb-lineup-filter-button";
      filterRow.appendChild(toggle);
      return;
    }
    // Do not float the control over the page if the lineup filters are not
    // present yet. It will be inserted when FotMob renders them.
    if (!filterRow && toggle.parentElement) toggle.remove();
  }

  function placeStatus(status) {
    const host = document.body || document.documentElement;
    if (host && status.parentElement !== host) host.appendChild(status);
  }

  function setStatus(message, visible = true) {
    const { status } = getOrCreateUi();
    status.textContent = message;
    status.hidden = !visible || !message;
  }

  function updateToggle() {
    const { toggle } = getOrCreateUi();
    toggle.setAttribute("aria-pressed", String(activeMode === "fc"));
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
    let bench = team.bench || team.benchPlayers || [];
    if (!Array.isArray(bench) && bench && typeof bench === "object") {
      bench = bench.players || bench.bench || bench.substitutes || [];
    }

    // Completed-match FotMob data keeps substitutes in the bench collection
    // and marks players who entered with timeSubbedOn/subbedOn. Include the
    // entire bench, then deduplicate against the explicit substitute list.
    const allPlayers = [...starters, ...explicitSubs, ...flattenPlayers(bench)];
    const seen = new Set();
    return allPlayers.filter(player => {
      const id = player.id ?? player.playerId;
      const name = player.name || player.localizedName || "";
      const key = id != null ? "id:" + String(id) : "name:" + name.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
        // applyDatabaseRatings reports match coverage and visible lineup updates.
        applyDatabaseRatings();
      }
    } catch (error) {
      console.error("[FC Match Companion]", error);
      if (activeMode === "fc") setStatus(error.message || "Unable to load FC Database OVRs.");
    }
  }

  function getFotMobPlayerId(anchor) {
    const href = anchor.getAttribute("href") || "";
    const pathMatch = href.match(PLAYER_LINK);
    if (pathMatch) return pathMatch[1];
    try {
      const url = new URL(href, location.origin);
      const queryId = url.searchParams.get("player");
      if (queryId && /^\d+$/.test(queryId)) return queryId;
    } catch (_) {}
    return "";
  }

  function matchesOrContains(element, classFragment) {
    return element.matches('[class*="' + classFragment + '"]') ||
      Boolean(element.querySelector('[class*="' + classFragment + '"]'));
  }

  function findPlayerCardRoot(playerAnchor) {
    if (playerAnchor.matches('[class*="LineupPlayerCSS"]')) return playerAnchor;
    return playerAnchor.querySelector('[class*="LineupPlayerCSS"]') || playerAnchor;
  }

  function findRatingPill(playerAnchor) {
    // The rating wrapper can be nested inside the link or attached to a
    // player-card element that is itself the link.
    const root = findPlayerCardRoot(playerAnchor);
    return root.matches('div[class*="PlayerRatingCSS"]')
      ? root
      : root.querySelector('div[class*="PlayerRatingCSS"]');
  }

  function rememberOriginal(node) {
    if (savedPills.has(node)) return;
    savedPills.set(node, {
      html: node.innerHTML,
      text: node.textContent,
      className: node.getAttribute("class"),
      style: node.getAttribute("style"),
      title: node.getAttribute("title"),
      ariaLabel: node.getAttribute("aria-label"),
      hidden: node.hidden
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
    // Upcoming fixtures and unavailable players often have no FotMob rating
    // component. Place our replacement in the portrait itself so its position
    // matches the native rating badge used on completed-match lineups.
    const cardRoot = findPlayerCardRoot(anchor);
    const portrait = cardRoot.matches('[class*="PlayerHeadContainer"]')
      ? cardRoot
      : cardRoot.querySelector('[class*="PlayerHeadContainer"]') ||
        anchor.querySelector('[class*="PlayerHeadContainer"]');
    if (!portrait) return null;

    let pill = portrait.querySelector(".fcdb-injected-rating");
    if (!pill) {
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
      portrait.appendChild(pill);
      injectedPills.set(pill, pill);
    }
    pill.textContent = result.rating == null ? "—" : String(result.rating);
    pill.className = "fcdb-rating-pill fcdb-injected-rating " + toneForRating(result.rating);
    pill.hidden = false;
    return pill;
  }

  function applyDatabaseRatings() {
    if (activeMode !== "fc" || !ratingByFotMobId.size) return;
    const anchors = [...document.querySelectorAll('a[href*="/players/"], a[href*="player="]')]
      .filter(anchor =>
        matchesOrContains(anchor, "LineupPlayerCSS") &&
        matchesOrContains(anchor, "PlayerHeadContainer")
      );
    let updated = 0;

    for (const anchor of anchors) {
      const playerId = getFotMobPlayerId(anchor);
      if (!playerId) continue;
      const result = ratingByFotMobId.get(playerId);
      if (!result) continue;

      const nativePill = findRatingPill(anchor);
      if (nativePill) {
        // FotMob already renders a decimal rating in this player row. Replace
        // that exact element instead of adding a second pill beside the name.
        rememberOriginal(nativePill);
        // Remove FotMob's player-of-the-match star and accessibility label.
        // They are not part of the OVR and otherwise distort the badge size.
        nativePill.replaceChildren(document.createTextNode(result.rating == null ? "—" : String(result.rating)));
        nativePill.classList.add("fcdb-rating-pill");
        nativePill.classList.remove(...TONE_CLASSES);
        nativePill.classList.add(toneForRating(result.rating));
        nativePill.title = result.fcradarUrl
          ? "FC Database OVR - click to open this player on FCRadar"
          : "FC Database OVR";
        if (result.fcradarUrl && !nativePill.dataset.fcdbLinkBound) {
          nativePill.dataset.fcdbLinkBound = "true";
          nativePill.style.cursor = "pointer";
          nativePill.addEventListener("click", () => {
            const current = ratingByFotMobId.get(playerId);
            if (current?.fcradarUrl) window.open(current.fcradarUrl, "_blank", "noopener");
          });
        }
      } else {
        const injected = createInjectedPill(anchor, playerId, result);
        if (!injected) continue;
      }
      updated++;
    }

    const signature = activeMatchId + ":" + updated + ":" + anchors.length;
    if (signature !== lastApplySignature) {
      lastApplySignature = signature;
      if (!updated) setStatus("FC Database ratings are loaded. Waiting for FotMob's lineup players to appear...");
      else setStatus("FC Database: " + [...ratingByFotMobId.values()].filter(result => result.rating != null).length +
        "/" + ratingByFotMobId.size + " players matched · " + updated + " lineup pills updated.");
    }
  }

  function restoreFotMobRatings() {
    for (const [node, original] of savedPills) {
      if (!node.isConnected) continue;
      if (original.html != null) node.innerHTML = original.html;
      else node.textContent = original.text;
      if (original.className == null) node.removeAttribute("class");
      else node.setAttribute("class", original.className);
      if (original.style == null) node.removeAttribute("style");
      else node.setAttribute("style", original.style);
      if (original.title == null) node.removeAttribute("title");
      else node.setAttribute("title", original.title);
      if (original.ariaLabel == null) node.removeAttribute("aria-label");
      else node.setAttribute("aria-label", original.ariaLabel);
      node.hidden = original.hidden;
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