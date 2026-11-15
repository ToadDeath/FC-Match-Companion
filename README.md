# FC Match Companion

A FotMob match companion that overlays EA Sports FC Career Mode player ratings on real-world match lineups.

## Current stack

- GitHub Pages frontend
- Supabase Edge Functions backend
- FotMob match details
- FCRadar FC 27 Career Mode player data

## Browser configuration

Edit `config.js` and set `supabaseAnonKey` to the project's Supabase anon / publishable key. The Supabase project URL is already filled in.

The anon / publishable key is intended for browser use. **Never put the FCRadar API key or the Supabase service-role key in frontend files.**

## Supabase Edge Function

The function source is in `supabase/functions/match-companion/index.ts`.

Deploy it from the project root with the Supabase CLI:

```bash
supabase functions deploy match-companion --project-ref czjbxpizhovhktfejbay
supabase secrets set FCRADAR_API_KEY=your_key_here --project-ref czjbxpizhovhktfejbay
```

The FCRadar secret has already been added in the Supabase dashboard. Do not paste it into this repository or into chat.

## Status

The first scaffold includes the dark responsive match interface, rating-mode control, FotMob URL parsing, and a server-side FotMob match-details request. The next implementation step is to map the returned lineup structure and connect each player to FCRadar's FC 27 Career Mode OVR data. The FCRadar API is in beta, so endpoint parameters and response schemas will be checked against its current reference before that integration is added.

Free-tier FCRadar use requires visible attribution to [FCRadar](https://fcradar.gg/). This project includes that credit in the interface.
