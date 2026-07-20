-- Phase 2 M8 — L2 KYC (Mock NIBSS) + payouts, payout-gated. A seller lists/sells
-- freely; they cannot be PAID OUT until L2-verified.

-- ── KYC verifications ─────────────────────────────────────────────────────────
-- PRIVACY-CRITICAL: this table stores the MATCH RESULT ONLY. There is deliberately
-- NO column for the BVN/NIN number — the number is sent to the (mock) NIBSS provider
-- in memory and NEVER persisted. That's the provable guarantee (CBN/NDPA posture).
create table if not exists public.kyc_verifications (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  id_type      text    not null check (id_type in ('bvn', 'nin')),
  matched      boolean not null,
  level        smallint not null check (level in (1, 2)),
  selfie_path  text,                    -- object key in the private kyc-selfies bucket
  provider_ref text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.kyc_verifications enable row level security;
drop policy if exists kyc_select_own on public.kyc_verifications;
create policy kyc_select_own on public.kyc_verifications for select using (auth.uid() = user_id);

-- ── Payouts (seller_payable → external), one per deal, L2-gated ───────────────
create table if not exists public.payouts (
  id           uuid primary key default gen_random_uuid(),
  deal_id      uuid not null unique references public.deals (id) on delete restrict,
  seller_id    uuid not null references auth.users (id) on delete restrict,
  amount_kobo  bigint not null check (amount_kobo > 0),
  status       text not null default 'pending' check (status in ('pending', 'settled', 'failed')),
  provider_ref text,
  created_at   timestamptz not null default now(),
  settled_at   timestamptz
);
create index if not exists payouts_seller_idx on public.payouts (seller_id, created_at desc);
alter table public.payouts enable row level security;
drop policy if exists payouts_select_own on public.payouts;
create policy payouts_select_own on public.payouts for select using (auth.uid() = seller_id);

-- ── Ledger: the reserved 'payout' movement is now a real writer ──────────────
-- Payout entries are keyed to a deal (per-deal payout), so the existing deal-keyed
-- idempotency index and reconcile invariants keep working unchanged.

-- ── Private KYC selfie bucket ────────────────────────────────────────────────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('kyc-selfies', 'kyc-selfies', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;
