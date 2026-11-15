import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.FC_MATCH_CONFIG || {};
const form = document.querySelector("#match-form");
const urlInput = document.querySelector("#match-url");
const loadButton = document.querySelector("#load-button");
const statusEl = document.querySelector("#status");
const matchContent = document.querySelector("#match-content");
const emptyState = document.querySelector("#empty-state");
const modeButtons = [...document.querySelectorAll(".switch-option")];
let ratingMode = "fotmob";
let supabase = null;

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
  } catch { return null; }
}
function safeText(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);
}

modeButtons.forEach(button => button.addEventListener("click", () => {
  ratingMode = button.dataset.mode;
  modeButtons.forEach(item => {
    const active = item === button;
    item.classList.toggle("active", active);
    item.setAttribute("aria-pressed", String(active));
  });
  document.querySelectorAll("[data-fc-rating], [data-fotmob-rating]").forEach(node => {
    const value = ratingMode === "fc" ? node.dataset.fcRating : node.dataset.fotmobRating;
    node.textContent = value || "—";
    node.classList.toggle("rating-unavailable", !value);
  });
}));

form.addEventListener("submit", async event => {
  event.preventDefault();
  const url = urlInput.value.trim();
  const matchId = matchIdFromUrl(url);
  if (!matchId) {
    setStatus("That link doesn't appear to contain a FotMob match ID. Open the match page and copy its full URL.", "error");
    return;
  }
  if (!supabase) {
    setStatus("One setup step remains: add your Supabase anon / publishable key in config.js. This is a public browser key, not your FCRadar key.", "error");
    return;
  }

  loadButton.disabled = true;
  loadButton.classList.add("loading");
  loadButton.querySelector("span").textContent = "Loading...";
  setStatus("Connecting to FotMob and loading match details...", "loading");
  try {
    const { data, error } = await supabase.functions.invoke("match-companion", {
      body: { action: "match", matchId }
    });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || "The match could not be loaded.");
    emptyState.classList.add("hidden");
    matchContent.classList.remove("hidden");
    matchContent.innerHTML = `
      <div class="connected-card">
        <div class="connected-icon">✓</div>
        <div><strong>Match data received</strong><p>FotMob match ID <code>${safeText(matchId)}</code> is connected. The next build step is mapping the lineup and matching players to FC 27 ratings.</p></div>
      </div>`;
    setStatus("FotMob connection successful.", "success");
  } catch (error) {
    setStatus(error.message || "Something went wrong while loading the match.", "error");
  } finally {
    loadButton.disabled = false;
    loadButton.classList.remove("loading");
    loadButton.querySelector("span").textContent = "Load match";
  }
});
