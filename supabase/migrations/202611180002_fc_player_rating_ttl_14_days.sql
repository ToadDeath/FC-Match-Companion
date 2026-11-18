-- Apply the 14-day refresh policy to ratings already stored.
update public.fc_player_ratings
set expires_at = fetched_at + interval '14 days'
where expires_at > fetched_at + interval '14 days';
