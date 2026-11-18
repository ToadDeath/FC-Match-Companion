-- Persistent FC Database identity and rating cache
-- Run this once in Supabase Dashboard > SQL Editor before deploying the updated Edge Function.

create table if not exists public.fc_player_identities (
  fcradar_player_id text primary key,
  fotmob_player_id text unique,
  player_name text not null,
  common_name text,
  first_name text,
  last_name text,
  identity_source text not null default 'fcradar_exact_name',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists fc_player_identities_fotmob_idx
  on public.fc_player_identities (fotmob_player_id);

create table if not exists public.fc_player_ratings (
  fcradar_player_id text not null references public.fc_player_identities(fcradar_player_id) on delete cascade,
  game_code text not null,
  overall_rating integer not null,
  club_name text,
  position text,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (fcradar_player_id, game_code)
);

create index if not exists fc_player_ratings_expiry_idx
  on public.fc_player_ratings (expires_at);

alter table public.fc_player_identities enable row level security;
alter table public.fc_player_ratings enable row level security;

revoke all on public.fc_player_identities from anon, authenticated;
revoke all on public.fc_player_ratings from anon, authenticated;
grant all on public.fc_player_identities to service_role;
grant all on public.fc_player_ratings to service_role;
