-- Phase 3 E — Property shortlets (designs 13g-shortlet, 22a-shortlet, -booked, -host).
-- Re-runnable.
--
-- A shortlet is Property's one escrow path: a dated booking, instant (no host
-- approval). The guest picks dates and pays the stay (nights + cleaning) plus a
-- refundable caution deposit into escrow. The booking is a deal born in ACCEPTED
-- (genesis action 'book') with two escrow stages (deal_milestones):
--   1 · the stay    — released to the host at checkout (SYSTEM 'check_out')
--   2 · the deposit — returned to the guest 48h after checkout (auto_release), unless
--                     the host claims it ('claim_deposit' → an admin decides)
-- A problem reported during the stay is an ordinary dispute and freezes everything.

-- ── Genesis guard: a guest's booking is the third legal way to open a deal ──────
create or replace function public.deal_events_guard() returns trigger language plpgsql as $$
begin
  if new.from_state is null then
    if not ((new.action = 'offer' and new.to_state = 'OFFERED' and new.actor = 'BUYER')
         or (new.action = 'quote' and new.to_state = 'COUNTERED_BY_SELLER' and new.actor = 'SELLER')
         or (new.action = 'book' and new.to_state = 'ACCEPTED' and new.actor = 'BUYER')) then
      raise exception 'illegal genesis event: actor=% action=% to=%', new.actor, new.action, new.to_state;
    end if;
  elsif public.deal_next_state(new.from_state, new.actor, new.action) is distinct from new.to_state then
    raise exception 'illegal transition: % [%/%] -> % (guard allows %)',
      new.from_state, new.actor, new.action, new.to_state,
      coalesce(public.deal_next_state(new.from_state, new.actor, new.action), 'NONE');
  end if;
  return new;
end;
$$;

-- ── Stages: a deposit can be returned while the deal lives on ───────────────────
-- 'refunding' = a return requested, awaiting the partner's settlement (the stage
-- twin of 'releasing'). A whole-deal refund still goes held → refunded on settlement.
alter table public.deal_milestones drop constraint if exists deal_milestones_status_check;
alter table public.deal_milestones add constraint deal_milestones_status_check
  check (status in ('held', 'releasing', 'released', 'refunding', 'refunded'));

create or replace function public.deal_milestones_guard() returns trigger language plpgsql as $$
begin
  if new.deal_id <> old.deal_id or new.idx <> old.idx
     or new.amount_kobo <> old.amount_kobo or new.title <> old.title then
    raise exception 'deal_milestones: stage % of deal % is immutable once held', old.idx, old.deal_id;
  end if;
  if new.status <> old.status and not (
       (old.status = 'held' and new.status in ('releasing', 'refunding', 'refunded'))
    or (old.status = 'releasing' and new.status = 'released')
    or (old.status = 'refunding' and new.status = 'refunded')) then
    raise exception 'deal_milestones: illegal stage move % -> % (deal %, stage %)',
      old.status, new.status, old.deal_id, old.idx;
  end if;
  return new;
end $$;

-- ── Bookings: the dates a deal holds ─────────────────────────────────────────────
-- One row per booking deal. The exclusion constraint is THE double-booking guard:
-- two active stays on one listing can never overlap, whatever the app does. Nights
-- are [check_in, check_out) — a checkout day is free for the next check-in.
create extension if not exists btree_gist with schema extensions;

create table if not exists public.bookings (
  deal_id     uuid    primary key references public.deals (id) on delete restrict,
  listing_id  uuid    not null references public.listings (id) on delete restrict,
  check_in    date    not null,
  check_out   date    not null,
  guests      smallint not null check (guests between 1 and 20),
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  check (check_out > check_in),
  check (check_out - check_in <= 30)
);
alter table public.bookings drop constraint if exists bookings_no_overlap;
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (listing_id with =, daterange(check_in, check_out, '[)') with &&)
  where (active);
create index if not exists bookings_listing_idx on public.bookings (listing_id, check_in) where active;

-- A booking that ends without a stay frees its dates: the guest withdrew or never
-- paid (EXPIRED), the host cancelled, or escrow refunded the guest in full.
create or replace function public.bookings_release_dates() returns trigger language plpgsql as $$
begin
  if new.state in ('WITHDRAWN', 'DECLINED', 'EXPIRED', 'REFUNDED') and new.state is distinct from old.state then
    update public.bookings set active = false where deal_id = new.id and active;
  end if;
  return new;
end $$;
drop trigger if exists bookings_release_dates on public.deals;
create trigger bookings_release_dates
  after update of state on public.deals
  for each row execute function public.bookings_release_dates();

-- Parties read their own booking; availability is public through the API (dates
-- only, never who). All writes are the API's.
alter table public.bookings enable row level security;
drop policy if exists bookings_party_select on public.bookings;
create policy bookings_party_select on public.bookings
  for select to authenticated using (
    exists (select 1 from public.deals d
            where d.id = deal_id and auth.uid() in (d.buyer_id, d.seller_id)));
revoke insert, update, delete on public.bookings from anon, authenticated;
