-- Phase 2 M4 — double-entry ledger (an orchestration mirror of the escrow partner's
-- custody) + a requested_action column on deal_events so idempotency replay survives
-- an EFFECTS redirect (e.g. payment_confirmed → oversold → REFUNDED). Money is always
-- integer kobo; a per-txn_group balance=0 invariant is enforced in the DB.

-- ── Chart of accounts ────────────────────────────────────────────────────────
-- System accounts; per-user/-deal attribution is via ledger_entries.deal_id.
--   external       — the outside world (buyer card / bank); money entering/leaving
--   escrow_holding — funds held pending release to the seller
--   wcp_fees       — WCP fee revenue
--   seller_payable — owed to the seller after release (M5)
create table if not exists public.ledger_accounts (
  id         text primary key,
  kind       text not null check (kind in ('external', 'escrow', 'fee_revenue', 'seller_payable')),
  created_at timestamptz not null default now()
);
insert into public.ledger_accounts (id, kind) values
  ('external', 'external'),
  ('escrow_holding', 'escrow'),
  ('wcp_fees', 'fee_revenue'),
  ('seller_payable', 'seller_payable')
on conflict (id) do nothing;

-- ── Append-only double-entry ledger ──────────────────────────────────────────
-- Each txn_group is ONE balanced money event; sum(amount_kobo) per group must be 0
-- (deferred check → all rows of the group are present at commit). Signed amounts:
-- positive credits the account's balance.
create table if not exists public.ledger_entries (
  id           bigint  generated always as identity primary key,
  txn_group    uuid    not null,
  deal_id      uuid    not null references public.deals (id) on delete restrict,
  event_seq    integer,                                   -- deal_events.seq that caused it
  account      text    not null references public.ledger_accounts (id),
  amount_kobo  bigint  not null,
  movement     text    not null check (movement in ('hold', 'release', 'refund', 'payout')),
  provider_ref text,
  created_at   timestamptz not null default now()
);
create index if not exists ledger_entries_deal_idx on public.ledger_entries (deal_id, id);
create index if not exists ledger_entries_group_idx on public.ledger_entries (txn_group);

-- Idempotent per (deal, movement, provider_ref, account): a redelivered provider
-- event can't double-book. A balanced event has one row per account, so account is
-- part of the key.
create unique index if not exists ledger_entries_idem
  on public.ledger_entries (deal_id, movement, provider_ref, account)
  where provider_ref is not null;

-- Balance invariant: every txn_group nets to zero. Deferred so a multi-row money
-- event is checked once at commit, not mid-insert.
create or replace function public.ledger_group_balanced() returns trigger language plpgsql as $$
declare s bigint;
begin
  select coalesce(sum(amount_kobo), 0) into s from public.ledger_entries where txn_group = new.txn_group;
  if s <> 0 then
    raise exception 'ledger txn_group % unbalanced (sum=%)', new.txn_group, s;
  end if;
  return null;
end $$;

drop trigger if exists ledger_balanced on public.ledger_entries;
create constraint trigger ledger_balanced
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.ledger_group_balanced();

-- Append-only: the ledger is a legal record (reuse the deal_events raise-on-write fn).
drop trigger if exists ledger_entries_no_update on public.ledger_entries;
create trigger ledger_entries_no_update
  before update on public.ledger_entries
  for each row execute function public.deal_events_append_only();

-- Internal tables — service-role only.
alter table public.ledger_accounts enable row level security;
alter table public.ledger_entries  enable row level security;

-- ── deal_events.requested_action ─────────────────────────────────────────────
-- The action the caller REQUESTED, before any EFFECTS redirect changed the recorded
-- action (payment_confirmed → oversold). Idempotency replay matches on this so a
-- redelivered webhook is a clean replay, not a false key-reuse rejection.
alter table public.deal_events add column if not exists requested_action text;
