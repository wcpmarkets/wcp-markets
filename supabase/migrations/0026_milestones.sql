-- Phase 3 D-2 — milestone escrow for Services (22c-quotebuild, 22c-quotecard-staged,
-- 22c-milestone). Re-runnable. Apply AFTER the regenerated 0006 (deal_next_state gains
-- release_stage: HANDED_OFF → PAID_IN_ESCROW, BUYER/SYSTEM).
--
-- A provider may split a big job's quote into 2–6 stages that sum to the price. The
-- buyer funds the whole price into escrow once; each stage is then marked done by the
-- provider (hand_off), confirmed by the buyer (or auto-released after 48h), and only
-- that stage's money moves. A dispute freezes whatever is still held; a refund
-- returns only the held stages.
--
-- While negotiating, the plan lives in deals.terms.milestones (it changes with each
-- counter). On funding the API materialises it here; from then on every release,
-- refund and reconciliation check works against these rows.

-- ── Stages ───────────────────────────────────────────────────────────────────
create table if not exists public.deal_milestones (
  deal_id      uuid        not null references public.deals (id) on delete restrict,
  idx          smallint    not null check (idx between 1 and 6),
  title        text        not null check (char_length(title) between 1 and 60),
  amount_kobo  bigint      not null check (amount_kobo > 0),
  status       text        not null default 'held'
                           check (status in ('held', 'releasing', 'released', 'refunded')),
  release_seq  integer,                 -- deal_events.seq whose effect requested the release
  provider_ref text,                    -- the settled release's partner ref
  released_at  timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (deal_id, idx)
);

drop trigger if exists deal_milestones_touch_updated_at on public.deal_milestones;
create trigger deal_milestones_touch_updated_at
  before update on public.deal_milestones
  for each row execute function public.touch_updated_at();

-- Money only moves forward: held → releasing → released, or held → refunded. What a
-- stage is for and what it's worth never change once escrow holds it.
create or replace function public.deal_milestones_guard() returns trigger language plpgsql as $$
begin
  if new.deal_id <> old.deal_id or new.idx <> old.idx
     or new.amount_kobo <> old.amount_kobo or new.title <> old.title then
    raise exception 'deal_milestones: stage % of deal % is immutable once held', old.idx, old.deal_id;
  end if;
  if new.status <> old.status and not (
       (old.status = 'held' and new.status in ('releasing', 'refunded'))
    or (old.status = 'releasing' and new.status = 'released')) then
    raise exception 'deal_milestones: illegal stage move % -> % (deal %, stage %)',
      old.status, new.status, old.deal_id, old.idx;
  end if;
  return new;
end $$;
drop trigger if exists deal_milestones_guard on public.deal_milestones;
create trigger deal_milestones_guard
  before update on public.deal_milestones
  for each row execute function public.deal_milestones_guard();

-- The stages are exactly the price: checked at commit (deferred), so all of a deal's
-- stages are inserted before the sum is compared to deals.price_kobo.
create or replace function public.deal_milestones_sum() returns trigger language plpgsql as $$
declare total bigint; price bigint;
begin
  select coalesce(sum(amount_kobo), 0) into total from public.deal_milestones where deal_id = new.deal_id;
  select price_kobo into price from public.deals where id = new.deal_id;
  if total <> price then
    raise exception 'deal_milestones: stages of deal % sum to % but the price is %', new.deal_id, total, price;
  end if;
  return null;
end $$;
drop trigger if exists deal_milestones_sum on public.deal_milestones;
create constraint trigger deal_milestones_sum
  after insert on public.deal_milestones
  deferrable initially deferred
  for each row execute function public.deal_milestones_sum();

-- Parties read (the job card + 22c-milestone update live); all writes are the API's.
alter table public.deal_milestones enable row level security;
drop policy if exists deal_milestones_party_select on public.deal_milestones;
create policy deal_milestones_party_select on public.deal_milestones
  for select to authenticated using (
    exists (select 1 from public.deals d
            where d.id = deal_id and auth.uid() in (d.buyer_id, d.seller_id)));
revoke insert, update, delete on public.deal_milestones from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.deal_milestones; exception when duplicate_object then null; end;
  end if;
end $$;

-- ── Payouts in parts ─────────────────────────────────────────────────────────
-- A staged job's provider withdraws as stages release, so a deal can have several
-- payouts (part 0, 1, …) — but never two in flight. Unstaged deals keep exactly one
-- (part 0), so nothing about their payouts changes.
alter table public.payouts add column if not exists part integer not null default 0 check (part >= 0);
alter table public.payouts drop constraint if exists payouts_deal_id_key;
create unique index if not exists payouts_deal_part_key on public.payouts (deal_id, part);
create unique index if not exists payouts_one_pending_per_deal on public.payouts (deal_id) where status = 'pending';
