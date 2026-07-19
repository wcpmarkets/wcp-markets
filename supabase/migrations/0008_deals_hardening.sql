-- Phase 2 M3 hardening — from the Fable review of the transactional core, folded in
-- before M4 (real money). All cheaper now than after the first naira moves.

-- ── #1  Preserve the financial audit trail ────────────────────────────────────
-- A deal (and its money history, post-M4) must SURVIVE user deletion; accounts with
-- deals get anonymized, never hard-deleted, in prod. `listing_id` already used
-- RESTRICT — bring the party FKs in line (they were ON DELETE CASCADE).
alter table public.deals drop constraint if exists deals_buyer_id_fkey;
alter table public.deals add constraint deals_buyer_id_fkey
  foreign key (buyer_id) references auth.users (id) on delete restrict;

alter table public.deals drop constraint if exists deals_seller_id_fkey;
alter table public.deals add constraint deals_seller_id_fkey
  foreign key (seller_id) references auth.users (id) on delete restrict;

-- ── price semantics (frozen: TOTAL, not per-unit) ─────────────────────────────
-- price_kobo is the whole amount the buyer pays for the deal; qty is informational
-- for stock. The M4 charge path uses price_kobo directly — no multiplication.
comment on column public.deals.price_kobo is
  'TOTAL price the buyer pays for the deal, in kobo (NOT per-unit). qty is informational for stock.';

-- ── #5  deal_events is the legal record → block history rewrites ───────────────
-- UPDATE is always illegal (tamper-evidence: an amount/state can never be rewritten
-- after the fact). DELETE is left to the FK cascade (a deliberate deal removal,
-- gated in prod by the RESTRICT FKs above) so test cleanup / GDPR erasure still work.
create or replace function public.deal_events_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'deal_events is append-only (% blocked)', tg_op;
end;
$$;
drop trigger if exists deal_events_no_update on public.deal_events;
create trigger deal_events_no_update
  before update on public.deal_events
  for each row execute function public.deal_events_append_only();

-- ── #4  Harden the outbox for at-least-once money delivery (M4 payout/refund) ──
-- Carry the source (deal_id, event_seq) so a consumer can dedupe + order under
-- at-least-once + SQS reordering, and track relay attempts so a poison row is
-- visible instead of retried forever in silence.
alter table public.outbox add column if not exists deal_id     uuid;
alter table public.outbox add column if not exists event_seq   integer;
alter table public.outbox add column if not exists attempts    integer not null default 0;
alter table public.outbox add column if not exists last_error  text;
