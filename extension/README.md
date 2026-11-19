# FC Match Companion for FotMob

This Chrome extension adds a **FotMob | FC Database** selector to FotMob match pages. It loads the match lineup as soon as the match ID is available. In FC Database mode, it displays the OVR beside each matched player and applies FC-style rating colors. OVRs link to the corresponding FCRadar player profile when the backend has a confirmed player match. Existing FotMob rating pills are hidden while FC Database mode is active and restored when switching back.

## Install in Chrome

1. Download this repository as a ZIP from GitHub, or clone it if you already use Git.
2. Extract the ZIP.
3. Open `chrome://extensions`.
4. Turn on **Developer mode**.
5. Choose **Load unpacked**.
6. Select the repository's `extension` folder.
7. Open or refresh a FotMob match page.

The extension only runs on `https://www.fotmob.com/*` and calls this project's Supabase Edge Function. The FCRadar API key is never included in the extension.

## Current limitations

- This is an initial integration. FotMob changes its page markup over time, so the extension locates lineup headings and player links dynamically. Some match views may need selector adjustments after real-world testing.
- FC Database ratings are loaded for players returned in the match lineup, including available substitutes and bench players.
- A missing FC Database OVR is shown as a neutral dash beside the player when the player is present in the loaded lineup.
- The extension currently targets Chrome Manifest V3. Firefox packaging can be added after the Chrome behavior is verified.

## Security

The Supabase publishable key in `config.js` is intended for browser use. Keep the FCRadar API key exclusively in Supabase Edge Function secrets.
