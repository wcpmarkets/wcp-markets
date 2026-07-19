-- Phase 2 M0 — user profiles + a Postgres-backed rate limiter.
-- Follows the 0001 convention: RLS on, minimal policies; the service-role API
-- (which bypasses RLS) owns transactional writes.

-- ── Profiles ──────────────────────────────────────────────────────────────
-- One row per auth user. verification_level: 1 = phone (L1), 2 = KYC/BVN+NIN (L2,
-- required before a seller's first payout). We never store the BVN/NIN itself —
-- only the match result, added in a later KYC migration.
create table if not exists public.profiles (
  id                 uuid        primary key references auth.users (id) on delete cascade,
  display_name       text,
  phone              text,
  verification_level smallint    not null default 1 check (verification_level in (1, 2)),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- A user may read/update only their own row directly (defense-in-depth; the API
-- reads/writes via the service role). Inserts happen through the API on first
-- sign-in, so no client insert policy.
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (auth.uid() = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (auth.uid() = id);

-- ── Rate limiter ──────────────────────────────────────────────────────────
-- Fixed-window counters, keyed by an opaque bucket string. Only the service-role
-- API touches this table (RLS on, no policies).
create table if not exists public.rate_limits (
  bucket       text   not null,
  window_start bigint not null,          -- unix epoch (seconds) of the window start
  count        integer not null default 0,
  primary key (bucket, window_start)
);

alter table public.rate_limits enable row level security;

-- Atomically consume one unit against a fixed window; returns true if still within
-- `p_limit`. One round trip. Used to throttle the OTP path (SMS-pumping guard).
create or replace function public.consume_rate_limit(
  p_bucket      text,
  p_limit       integer,
  p_window_secs integer
) returns boolean
  language plpgsql
as $$
declare
  v_window bigint := (floor(extract(epoch from now()) / p_window_secs) * p_window_secs)::bigint;
  v_count  integer;
begin
  insert into public.rate_limits (bucket, window_start, count)
  values (p_bucket, v_window, 1)
  on conflict (bucket, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

-- Housekeeping: drop stale windows (call from a periodic job later).
create or replace function public.prune_rate_limits(p_older_than_secs integer default 86400)
  returns void
  language sql
as $$
  delete from public.rate_limits
  where window_start < (extract(epoch from now()) - p_older_than_secs);
$$;
