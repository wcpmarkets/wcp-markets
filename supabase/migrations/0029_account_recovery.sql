-- Phase 3 G — account recovery, signed-in devices, SMS alerts (all re-runnable).
--
-- Recovery (designs 20j-recover-1…4): someone who lost the number an account was
-- registered with proves they hold a NEW number (by signing in with it — a fresh,
-- empty account), then proves they own the old account (verified sellers: the same
-- BVN/NIN, matched by keyed hash; others: account facts). Access transfers only
-- after a 24h hold during which the old number is alerted and can cancel, and the
-- account's payouts are paused. The transfer moves the NEW number onto the OLD
-- account (auth.users.phone), deletes the empty placeholder account and signs every
-- old session out — all in one transaction (src/recovery/complete.ts).

-- ── Recovery requests ─────────────────────────────────────────────────────────
create table if not exists public.account_recoveries (
  id            uuid primary key default gen_random_uuid(),
  -- The account being recovered (the one registered to the lost number).
  account_id    uuid not null references auth.users(id) on delete cascade,
  -- The placeholder account the requester signed in with on the new number. Deleted
  -- at transfer, so the reference goes null rather than blocking that delete.
  requester_id  uuid references auth.users(id) on delete set null,
  lost_phone    text not null,          -- auth.users.phone format: digits, no '+'
  new_phone     text not null,
  -- seller: re-match BVN/NIN (account can withdraw escrow). basic: account facts.
  branch        text not null check (branch in ('seller', 'basic')),
  status        text not null check (status in ('identity', 'review', 'holding', 'completed', 'cancelled', 'failed')),
  -- Basic branch: the questions asked, with the answer key (never sent to clients).
  questions     jsonb,
  attempts      int not null default 0,
  hold_until    timestamptz,
  closed_reason text,                   -- why it was cancelled/failed (owner, requester, admin, attempts, …)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  closed_at     timestamptz
);

-- At most one OPEN recovery per account, and per requester.
create unique index if not exists account_recoveries_one_open
  on public.account_recoveries (account_id) where status in ('identity', 'review', 'holding');
create unique index if not exists account_recoveries_one_open_requester
  on public.account_recoveries (requester_id) where status in ('identity', 'review', 'holding');
-- The sweeper's scan: holds that have run out.
create index if not exists account_recoveries_due
  on public.account_recoveries (hold_until) where status = 'holding';

-- Service-role only: no client ever reads this table directly.
alter table public.account_recoveries enable row level security;

-- ── KYC: a keyed hash of the ID number, so recovery can re-match it ──────────
-- HMAC-SHA256(pepper, "<idType>:<number>") with the pepper in SSM. The number itself
-- is still never stored; the hash is useless without the pepper.
alter table public.kyc_verifications add column if not exists id_hash text;

-- ── SMS log ──────────────────────────────────────────────────────────────────
-- Every security SMS we send (or would send, under the mock): what, to whom, and the
-- provider's verdict — so an alert that didn't go out is visible, and tests can see it.
create table if not exists public.sms_log (
  id           bigserial primary key,
  to_phone     text not null,
  kind         text not null,            -- recovery_started / recovery_cancelled / recovery_completed / …
  body         text not null,
  provider     text not null,            -- termii / mock
  provider_ref text,
  status       text not null check (status in ('sent', 'failed', 'mocked')),
  error        text,
  recovery_id  uuid references public.account_recoveries(id) on delete set null,
  created_at   timestamptz not null default now()
);
create index if not exists sms_log_recovery on public.sms_log (recovery_id);
alter table public.sms_log enable row level security;
