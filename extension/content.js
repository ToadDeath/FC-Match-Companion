(() => {
  "use strict";

  const config = window.__FC_MATCH_COMPANION_CONFIG__ || {};
  const supabaseUrl = String(config.supabaseUrl || "").replace(/\/$/, "");
  const publishableKey = String(config.supabasePublishableKey || "");
  const savedPills = new Map();
  const injectedPills = new Map();
  const ratingByFotMobId = new Map();
  const starterIdsBySide = { home: [], away: [] };
  const visibleLookupPending = new Set();
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
      toggle = document.createElement("button");
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
      if (!filterRow.dataset.fcdbModeCoordinator) {
        // FC Database is a mode, not a FotMob stat filter. Selecting any
        // native lineup filter should automatically return to FotMob mode.
        filterRow.addEventListener("click", event => {
          const clickedButton = event.target.closest("button");
          if (clickedButton && clickedButton !== toggle && activeMode === "fc") {
            setMode("fotmob");
          }
        }, true);
        filterRow.dataset.fcdbModeCoordinator = "true";
      }
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
    starterIdsBySide.home = [];
    starterIdsBySide.away = [];

    for (const item of teams) {
      const team = teamLineup(lineup, item.side, item.header.id || (item.side === "home" ? general.homeTeam?.id : general.awayTeam?.id));
      const teamName = item.header.name || team.name || "";
      const starterList = flattenPlayers(team.starters || team.players || []);
      starterIdsBySide[item.side] = starterList
        .map(player => player.id ?? player.playerId)
        .filter(id => id != null)
        .map(String);
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
      Boolean(element.closest('[class*="' + classFragment + '"]')) ||
      Boolean(element.querySelector('[class*="' + classFragment + '"]'));
  }

  function findPlayerCardRoot(playerAnchor) {
    return playerAnchor.closest('[class*="LineupPlayerCSS"]') ||
      playerAnchor.closest('[class*="VerticalBenchPlayerCSS"]') ||
      playerAnchor.querySelector('[class*="LineupPlayerCSS"]') ||
      playerAnchor;
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
    // Recreate FotMob's two-level structure: TopRight positioning wrapper
    // plus its native PlayerRatingCSS pill. The Team rating badge supplies
    // FotMob's own PlayerRatingCSS class even on upcoming fixtures.
    const cardRoot = findPlayerCardRoot(anchor);
    const portrait = cardRoot.matches('[class*="PlayerHeadContainer"]')
      ? cardRoot
      : cardRoot.querySelector('[class*="PlayerHeadContainer"]') ||
        anchor.querySelector('[class*="PlayerHeadContainer"]');
    if (!portrait) return null;

    let wrapper = portrait.querySelector(".fcdb-injected-rating-wrapper");
    let pill = wrapper?.querySelector(".fcdb-injected-rating");
    if (!wrapper) {
      // Match the exact player-rating component from a completed FotMob match,
      // rather than borrowing the differently sized team-average badge.
      wrapper = document.createElement("div");
      wrapper.className = "css-upbi04-TopRight e16r8a9j11 fcdb-injected-rating-wrapper";
      wrapper.setAttribute("offset", "27px");
      pill = document.createElement("div");
      pill.className = "css-1gybtde-PlayerRatingCSS e1m6ml490 fcdb-rating-pill fcdb-injected-rating";
      pill.dataset.fcdbPlayerId = playerId;
      pill.title = result.fcradarUrl
        ? "FC Database OVR - click to open this player on FCRadar"
        : "FC Database OVR";
      pill.setAttribute("role", result.fcradarUrl ? "link" : "img");
      if (result.fcradarUrl) {
        pill.tabIndex = 0;
        pill.addEventListener("click", () => window.open(pill.dataset.fcradarUrl, "_blank", "noopener"));
        pill.addEventListener("keydown", event => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            window.open(pill.dataset.fcradarUrl, "_blank", "noopener");
          }
        });
      }
      wrapper.appendChild(pill);
      portrait.appendChild(wrapper);
      injectedPills.set(wrapper, wrapper);
    }
    pill.dataset.fcradarUrl = result.fcradarUrl || "";
    pill.replaceChildren(Object.assign(document.createElement("span"), {
      textContent: result.rating == null ? "—" : String(result.rating)
    }));
    pill.classList.remove(...TONE_CLASSES);
    pill.classList.add(toneForRating(result.rating));
    wrapper.hidden = false;
    return pill;
  }

  function applyDatabaseRatings() {
    if (activeMode !== "fc" || !ratingByFotMobId.size) return;
    const anchors = [...document.querySelectorAll('a[href*="/players/"], a[href*="player="]')]
      .filter(anchor => {
        // FotMob renders BOTH horizontal and vertical versions of each bench
        // player in the DOM. Only update the horizontal row, which already
        // has the compact native rating slot. Updating the hidden portrait
        // version creates a second, oversized-looking badge.
        const benchItem = anchor.closest('li[class*="BenchPlayerCSS"]');
        if (benchItem) {
          const horizontal = anchor.querySelector('[class*="LeftBenchItem"]');
          if (!horizontal) return false;
          // Coaches/staff can appear in FotMob's bench list but have neither
          // a shirt number nor a playing position.
          return Boolean(
            horizontal.querySelector('[class*="Shirt"]') ||
            [...horizontal.querySelectorAll('[class*="NotAvailableInfoContainer"]')]
              .some(node => node.textContent.trim())
          );
        }

        // Starters use the portrait layout. Require a shirt number or a
        // playing role so staff links are never treated as players.
        const playerCard = anchor.querySelector('[class*="LineupPlayerCSS"]') || anchor;
        return Boolean(
          playerCard.querySelector('[class*="Shirt"]') ||
          playerCard.querySelector('[class*="RoleTextCSS"]')
        );
      });
    let updated = 0;

    for (const anchor of anchors) {
      const playerId = getFotMobPlayerId(anchor);
      if (!playerId) continue;
      const result = ratingByFotMobId.get(playerId);
      if (!result) continue;

      const horizontalBench = anchor.closest('li[class*="BenchPlayerCSS"]') &&
        !anchor.querySelector('[class*="LineupPlayerCSS"]');
      if (horizontalBench) {
        const leftCard = anchor.querySelector('[class*="LeftBenchItem"]') ||
          anchor.querySelector('[class*="BenchItem"]') || anchor;
        let badgeRow = anchor.querySelector('[class*="FilterBadgesCSS"]');
        if (!badgeRow) {
          badgeRow = document.createElement("div");
          badgeRow.className = "css-jsdp74-HoriztonalFilterBadgesCSS e16r8a9j17";
          const portraitIcon = leftCard.querySelector(".PlayerIcon");
          if (portraitIcon?.nextSibling) leftCard.insertBefore(badgeRow, portraitIcon.nextSibling);
          else leftCard.appendChild(badgeRow);
          injectedPills.set(badgeRow, badgeRow);
        }
        let nativePill = badgeRow.querySelector('div[class*="PlayerRatingCSS"]');
        if (!nativePill) {
          nativePill = document.createElement("div");
          nativePill.className = "css-eqet27-PlayerRatingCSS e1m6ml490 fcdb-rating-pill";
          badgeRow.appendChild(nativePill);
          // This is an extension-created placeholder, not a FotMob pill.
          // Remove it on mode-off rather than restoring its FC styling.
          injectedPills.set(nativePill, nativePill);
        } else {
          rememberOriginal(nativePill);
        }
        nativePill.replaceChildren(Object.assign(document.createElement("span"), {
          textContent: result.rating == null ? "—" : String(result.rating)
        }));
        nativePill.classList.add("fcdb-rating-pill", "fcdb-bench-rating");
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
        updated++;
        continue;
      }

      const nativePill = findRatingPill(anchor);
      if (nativePill) {
        // FotMob already renders a decimal rating in this player row. Replace
        // that exact element instead of adding a second pill beside the name.
        rememberOriginal(nativePill);
        // Remove FotMob's player-of-the-match star and accessibility label.
        // They are not part of the OVR and otherwise distort the badge size.
        nativePill.replaceChildren(Object.assign(document.createElement("span"), {
          textContent: result.rating == null ? "—" : String(result.rating)
        }));
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

    updateTeamAverageBadges();
    loadVisiblePlayerRatings(anchors);
    const signature = activeMatchId + ":" + updated + ":" + anchors.length;
    if (signature !== lastApplySignature) {
      lastApplySignature = signature;
      if (!updated) setStatus("FC Database ratings are loaded. Waiting for FotMob's lineup players to appear...");
      else setStatus("FC Database: " + [...ratingByFotMobId.values()].filter(result => result.rating != null).length +
        "/" + ratingByFotMobId.size + " players matched · " + updated + " lineup pills updated.");
    }
  }


  function updateTeamAverageBadges() {
    const badges = [...document.querySelectorAll('[title="Team rating"] div[class*="PlayerRatingCSS"]')];
    const sides = ["home", "away"];
    badges.forEach((badge, index) => {
      const side = sides[index];
      if (!side) return;
      const ids = starterIdsBySide[side] || [];
      const values = ids.map(id => ratingByFotMobId.get(id)?.rating);
      const complete = ids.length === 11 && values.length === 11 &&
        values.every(value => Number.isFinite(value));
      const average = complete
        ? String(Math.round(values.reduce((sum, value) => sum + value, 0) / 11))
        : "—";
      rememberOriginal(badge);
      badge.replaceChildren(Object.assign(document.createElement("span"), { textContent: average }));
      badge.classList.add("fcdb-rating-pill");
      badge.classList.remove(...TONE_CLASSES);
      const numericAverage = complete ? Number(average) : null;
      badge.classList.add(toneForRating(numericAverage));
      badge.title = complete
        ? "FC Database starting XI average OVR"
        : "FC Database starting XI average unavailable - all 11 ratings are required";
    });
  }

  async function loadVisiblePlayerRatings(anchors) {
    const missing = [];
    for (const anchor of anchors) {
      const id = getFotMobPlayerId(anchor);
      if (!id || ratingByFotMobId.has(id) || visibleLookupPending.has(id)) continue;
      const card = findPlayerCardRoot(anchor);
      const nameNode = card.querySelector('[title]') ||
        card.querySelector('[class*="LineupPlayerText"]') ||
        card.querySelector('[class*="PlayerName"]');
      const name = nameNode?.getAttribute("title") || nameNode?.textContent?.trim() || "";
      if (!name) continue;
      visibleLookupPending.add(id);
      missing.push({
        key: "visible:" + id,
        fotmobId: id,
        name,
        position: card.querySelector('[class*="NotAvailableInfoContainer"]')?.textContent?.trim() ||
          card.querySelector('[class*="RoleTextCSS"]')?.textContent?.trim() || "",
        nationality: "",
        team: ""
      });
    }
    if (!missing.length) return;
    try {
      const response = await invoke("ratings", { players: missing });
      for (const player of missing) {
        const result = response.ratings?.[player.key];
        ratingByFotMobId.set(String(player.fotmobId), {
          rating: result?.rating == null ? null : Number(result.rating),
          status: result?.status || "not_found",
          fcradarUrl: result?.fcradarUrl || ""
        });
      }
      if (activeMode === "fc") applyDatabaseRatings();
    } catch (error) {
      console.warn("[FC Match Companion] Visible bench lookup failed", error);
    } finally {
      for (const player of missing) visibleLookupPending.delete(String(player.fotmobId));
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

    // Defensive cleanup: FotMob can replace or clone lineup nodes while the
    // extension is active. Remove any FCDB-only styling left on surviving
    // rating elements, even if that particular node was not in savedPills.
    document.querySelectorAll(".fcdb-rating-pill, .fcdb-injected-rating-wrapper").forEach(node => {
      node.classList.remove("fcdb-rating-pill", "fcdb-bench-rating", ...TONE_CLASSES);
      node.removeAttribute("data-fcdb-player-id");
      node.removeAttribute("data-fcdb-link-bound");
      node.removeAttribute("data-fcradar-url");
      if (node.classList.contains("fcdb-injected-rating-wrapper")) node.remove();
    });
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