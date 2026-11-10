-- Phase 3I — AI search.
--
-- A week's cache of interpreted searches, keyed by sha256(prompt version | model |
-- lane hint | normalised text). Most searches repeat; a repeat should cost nothing
-- and answer instantly. Holds only what the buyer typed, read into filters — no user
-- id, no IP — so it identifies nobody. Photos are never stored.
--
-- Service-role only: RLS on, no policies (clients never read it directly).

create table if not exists public.search_interpretations (
  key         text        primary key check (char_length(key) = 64),
  result      jsonb       not null,
  created_at  timestamptz not null default now()
);

create index if not exists search_interpretations_created_idx
  on public.search_interpretations (created_at);

alter table public.search_interpretations enable row level security;
