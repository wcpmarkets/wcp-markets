-- Phase 3 H — Paystack: real money in (checkout), back (refunds) and out (transfers).
-- All re-runnable.
--
-- Escrow model: the buyer pays WCP's Paystack balance; the money stays there, held,
-- until the deal releases it (an internal ledger move — nothing leaves Paystack) and
-- the seller asks for a payout (a Paystack Transfer to their bank). Refunds are
-- Paystack Refunds against the original transaction.
--
-- The buyer also pays Paystack's processing fee (decided 2026-11-10): the charge is
-- grossed up so that, after Paystack deducts its fee, exactly principal + WCP buyer
-- fee lands in custody — the ledger's hold is unchanged. The processing fee is not
-- refunded (Paystack keeps it).

-- Which rail a deal's money moves on. Set when the buyer pays; NULL until then.
-- 'mock' remains for automated test accounts (clitest+…@wcp-test.local), whose
-- end-to-end suites can't complete a real checkout.
alter table public.deals add column if not exists payment_provider text
  check (payment_provider in ('mock', 'paystack'));

-- One row per checkout attempt (a buyer who abandons and retries gets a new one).
create table if not exists public.payments (
  id                  uuid primary key default gen_random_uuid(),
  deal_id             uuid not null references public.deals(id) on delete restrict,
  reference           text not null unique,         -- our Paystack transaction reference
  net_kobo            bigint not null check (net_kobo > 0),            -- principal + WCP buyer fee
  processing_fee_kobo bigint not null check (processing_fee_kobo >= 0), -- our gross-up for Paystack
  gross_kobo          bigint not null check (gross_kobo = net_kobo + processing_fee_kobo),
  status              text not null default 'initialized'
                      check (status in ('initialized', 'success', 'failed', 'abandoned', 'refunded_late')),
  access_code         text,
  authorization_url   text,
  psp_fee_kobo        bigint,                        -- what Paystack actually took (from the webhook)
  channel             text,                          -- card / bank_transfer / ussd / …
  created_at          timestamptz not null default now(),
  paid_at             timestamptz,
  updated_at          timestamptz not null default now()
);
create index if not exists payments_deal on public.payments (deal_id, created_at desc);
-- The sweeper's scan: checkouts left open.
create index if not exists payments_open on public.payments (created_at) where status = 'initialized';
alter table public.payments enable row level security;

-- Refunds we asked Paystack for, so the refund webhook (which only names the Paystack
-- refund + transaction) maps back to the deal and, for a staged deal, the part.
create table if not exists public.payment_refunds (
  id                 uuid primary key default gen_random_uuid(),
  deal_id            uuid not null references public.deals(id) on delete restrict,
  part               int,                             -- a stage / the shortlet deposit; null = whole deal
  amount_kobo        bigint not null check (amount_kobo > 0),
  idempotency_key    text not null unique,            -- refund:<deal>[:part] — one per command
  paystack_refund_id text unique,
  status             text not null default 'pending' check (status in ('pending', 'processed', 'failed')),
  error              text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
alter table public.payment_refunds enable row level security;

-- Where a seller's payouts go (20m-payout). The full account number lives only at
-- Paystack (inside the transfer recipient); we keep the last 4 digits to show.
create table if not exists public.payout_accounts (
  user_id        uuid primary key references auth.users(id) on delete cascade,
  bank_code      text not null,
  bank_name      text not null,
  account_last4  text not null check (account_last4 ~ '^[0-9]{4}$'),
  account_name   text not null,                      -- as the bank resolved it
  recipient_code text not null,                      -- Paystack RCP_… (or mock_rcp_…)
  provider       text not null check (provider in ('mock', 'paystack')),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
alter table public.payout_accounts enable row level security;

-- A payout's Paystack transfer, so transfer.* webhooks map back.
alter table public.payouts add column if not exists transfer_reference text unique;
