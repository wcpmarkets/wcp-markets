-- Pooled withdrawals: one bank transfer (and one transfer fee) can pay out many sales.
--
-- A WITHDRAWAL is one transfer to the seller's bank. Its PAYOUTS rows are the lines
-- saying which sales it paid out and how much from each. The ledger stays per deal:
-- each line books its own seller_payable → external pair when the transfer settles.
--
-- Expand-only: everything here is additive, so the code running before the deploy
-- (per-deal payouts, withdrawal_id null) keeps working until the new code is live.
-- Idempotent (if not exists / drop … if exists), so a re-run is harmless.

-- ── Withdrawals ──────────────────────────────────────────────────────────────
create table if not exists public.withdrawals (
  id                 uuid primary key default gen_random_uuid(),
  seller_id          uuid not null references auth.users (id) on delete restrict,
  -- What leaves the seller's balance (the lines sum to this). The transfer fee is the
  -- seller's (product decision 2026-11-26): the bank receives amount − fee.
  amount_kobo        bigint not null check (amount_kobo > 0),
  fee_kobo           bigint not null default 0 check (fee_kobo >= 0),
  net_kobo           bigint generated always as (amount_kobo - fee_kobo) stored,
  -- What the provider says it actually charged, when it says (quote vs charged).
  actual_fee_kobo    bigint,
  status             text not null default 'pending'
                       check (status in ('pending', 'settled', 'failed', 'reversed')),
  rail               text not null check (rail in ('mock', 'paystack')),
  -- Where the money went, as it was when the withdrawal was made — the transfer uses
  -- this, so changing the payout account can't redirect a withdrawal mid-flight.
  recipient_code     text,
  bank_name          text,
  account_last4      text,
  transfer_reference text unique,
  provider_ref       text,
  idempotency_key    text,
  failure_reason     text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  settled_at         timestamptz,
  check (amount_kobo > fee_kobo)
);
create index if not exists withdrawals_seller_idx on public.withdrawals (seller_id, created_at desc);
-- A repeated tap (same key) gets the withdrawal it already made, per rail.
create unique index if not exists withdrawals_idem
  on public.withdrawals (seller_id, rail, idempotency_key) where idempotency_key is not null;
-- One withdrawal in flight per seller per rail: the race guard for two taps or two
-- phones, independent of any lock the code takes.
create unique index if not exists withdrawals_one_pending
  on public.withdrawals (seller_id, rail) where status = 'pending';

alter table public.withdrawals enable row level security;
drop policy if exists withdrawals_select_own on public.withdrawals;
create policy withdrawals_select_own on public.withdrawals for select using (auth.uid() = seller_id);

-- ── Payouts become the withdrawal's lines ────────────────────────────────────
alter table public.payouts add column if not exists withdrawal_id uuid references public.withdrawals (id) on delete restrict;
-- A sale appears at most once in a withdrawal (two lines for one deal under one
-- provider ref would collide on the ledger's idempotency index and one would drop).
create unique index if not exists payouts_withdrawal_deal on public.payouts (withdrawal_id, deal_id) where withdrawal_id is not null;
create index if not exists payouts_withdrawal_idx on public.payouts (withdrawal_id);
alter table public.payouts drop constraint if exists payouts_status_check;
alter table public.payouts add constraint payouts_status_check check (status in ('pending', 'settled', 'failed', 'reversed'));

-- A reversal after a settled transfer books the money back to the seller: the ledger
-- is append-only, so it needs its own movement.
alter table public.ledger_entries drop constraint if exists ledger_entries_movement_check;
alter table public.ledger_entries add constraint ledger_entries_movement_check
  check (movement in ('hold', 'release', 'refund', 'payout', 'payout_reversal'));

-- ── Invariants ───────────────────────────────────────────────────────────────
-- (1) A deal never owes its seller less than nothing: paying out more than was
-- released is a double payout. Checked at commit, after every ledger write.
create or replace function public.seller_payable_nonneg() returns trigger
language plpgsql as $$
declare bal bigint;
begin
  if new.account <> 'seller_payable' then return null; end if;
  select coalesce(sum(amount_kobo), 0) into bal from public.ledger_entries
   where deal_id = new.deal_id and account = 'seller_payable';
  if bal < 0 then
    raise exception 'seller_payable for deal % would be % (paid out more than released)', new.deal_id, bal
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
drop trigger if exists seller_payable_nonneg on public.ledger_entries;
create constraint trigger seller_payable_nonneg
  after insert on public.ledger_entries
  deferrable initially deferred
  for each row execute function public.seller_payable_nonneg();

-- (2) A new line can't claim more than the deal still owes (released, minus any other
-- line still in flight). The deal row is locked first, so two writers serialise.
create or replace function public.payout_line_within_balance() returns trigger
language plpgsql as $$
declare bal bigint; inflight bigint;
begin
  perform 1 from public.deals where id = new.deal_id for update;
  select coalesce(sum(amount_kobo), 0) into bal from public.ledger_entries
   where deal_id = new.deal_id and account = 'seller_payable';
  select coalesce(sum(amount_kobo), 0) into inflight from public.payouts
   where deal_id = new.deal_id and status = 'pending' and id <> new.id;
  if new.amount_kobo > bal - inflight then
    raise exception 'payout of % for deal % exceeds its balance % (in flight %)', new.amount_kobo, new.deal_id, bal, inflight
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists payout_line_within_balance on public.payouts;
create trigger payout_line_within_balance
  before insert on public.payouts
  for each row when (new.withdrawal_id is not null)
  execute function public.payout_line_within_balance();

-- (3) A withdrawal's lines add up to exactly its amount, and both are fixed once made.
create or replace function public.withdrawal_lines_sum() returns trigger
language plpgsql as $$
declare w uuid; total bigint; lines bigint;
begin
  -- Fired from both tables; only touch the column the firing table has.
  if tg_table_name = 'payouts' then
    if new.withdrawal_id is null then return null; end if;
    w := new.withdrawal_id;
  else
    w := new.id;
  end if;
  select amount_kobo into total from public.withdrawals where id = w;
  if total is null then return null; end if;
  select coalesce(sum(amount_kobo), 0) into lines from public.payouts where withdrawal_id = w;
  if lines <> total then
    raise exception 'withdrawal % lines sum to %, not its amount %', w, lines, total
      using errcode = 'check_violation';
  end if;
  return null;
end $$;
drop trigger if exists withdrawal_lines_sum on public.withdrawals;
create constraint trigger withdrawal_lines_sum
  after insert on public.withdrawals
  deferrable initially deferred
  for each row execute function public.withdrawal_lines_sum();
drop trigger if exists withdrawal_lines_sum on public.payouts;
create constraint trigger withdrawal_lines_sum
  after insert or update on public.payouts
  deferrable initially deferred
  for each row execute function public.withdrawal_lines_sum();

create or replace function public.withdrawal_amounts_fixed() returns trigger
language plpgsql as $$
begin
  if tg_table_name = 'withdrawals' then
    if new.amount_kobo <> old.amount_kobo or new.fee_kobo <> old.fee_kobo or new.seller_id <> old.seller_id then
      raise exception 'a withdrawal''s amount, fee and seller are fixed' using errcode = 'check_violation';
    end if;
  elsif old.withdrawal_id is not null and (
        new.withdrawal_id is distinct from old.withdrawal_id
     or new.deal_id <> old.deal_id or new.amount_kobo <> old.amount_kobo) then
    raise exception 'a withdrawal line''s deal and amount are fixed' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists withdrawal_amounts_fixed on public.withdrawals;
create trigger withdrawal_amounts_fixed before update on public.withdrawals
  for each row execute function public.withdrawal_amounts_fixed();
drop trigger if exists withdrawal_amounts_fixed on public.payouts;
create trigger withdrawal_amounts_fixed before update on public.payouts
  for each row execute function public.withdrawal_amounts_fixed();

-- ── Backfill: every existing payout becomes a one-line withdrawal (fee 0) ────
-- Same id as its payout, so a re-run inserts nothing. The ledger groups those
-- payouts already booked are left as they are (joined by provider_ref).
insert into public.withdrawals
  (id, seller_id, amount_kobo, fee_kobo, status, rail, provider_ref, transfer_reference, created_at, updated_at, settled_at)
select p.id, p.seller_id, p.amount_kobo, 0, p.status,
       case when d.payment_provider = 'paystack' then 'paystack' else 'mock' end,
       p.provider_ref, p.transfer_reference, p.created_at, coalesce(p.settled_at, p.created_at), p.settled_at
from public.payouts p join public.deals d on d.id = p.deal_id
where p.withdrawal_id is null
on conflict (id) do nothing;
update public.payouts p set withdrawal_id = p.id
where p.withdrawal_id is null and exists (select 1 from public.withdrawals w where w.id = p.id);
