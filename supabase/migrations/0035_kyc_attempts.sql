-- Phase 3J — Smile ID Biometric KYC. Verification is now asynchronous: the app captures
-- a selfie with the Smile ID SDK, Smile ID compares it with the BVN/NIN record's photo,
-- and the result arrives later (webhook, or our own status poll). Each try is an
-- attempt; a 'clear' attempt is what writes kyc_verifications + L2, exactly as the mock
-- match did.
--
-- PRIVACY: still no column for the BVN/NIN number. The attempt keeps only the keyed
-- hash (kyc/idhash.ts) so the verification row can carry it once the attempt clears.
-- Smile ID holds the selfie; we keep none.
create table if not exists public.kyc_attempts (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  id_type      text not null check (id_type in ('bvn', 'nin')),
  id_hash      text,
  provider     text not null check (provider in ('smileid', 'mock')),
  -- Smile ID's job (job_…), known once the app has submitted the capture.
  job_id       text unique,
  status       text not null default 'started'
               check (status in ('started', 'processing', 'clear', 'attention', 'block', 'error', 'abandoned')),
  reason       text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists kyc_attempts_user_idx on public.kyc_attempts (user_id, created_at desc);
-- Server-only: the API (service role) reads and writes it; no client policy.
alter table public.kyc_attempts enable row level security;
