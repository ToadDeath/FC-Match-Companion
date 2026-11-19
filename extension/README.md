# FC Match Companion for FotMob

This is the first Chrome extension build. It adds a floating **FotMob | FC Database** selector to FotMob match pages. FC Database mode requests the match lineup and OVRs from the existing Supabase Edge Function, then replaces detected FotMob rating pills with FC Database OVRs and matching FC-style colors. Switching back restores the original rating text and styling.

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

- This is an initial integration. FotMob changes its page markup over time, and the extension uses DOM detection to locate existing rating pills. Some match views may need selector adjustments after real-world testing.
- FC Database ratings are loaded for players returned in the match lineup, including available substitutes and bench players.
- A missing FC Database OVR is shown as a neutral dash when a corresponding FotMob rating pill can be identified.
- The extension currently targets Chrome Manifest V3. Firefox packaging can be added after the Chrome behavior is verified.

## Security

The Supabase publishable key in `config.js` is intended for browser use. Keep the FCRadar API key exclusively in Supabase Edge Function secrets.
