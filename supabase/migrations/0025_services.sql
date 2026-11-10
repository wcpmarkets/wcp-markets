-- Phase 3 D — the Services lane (design 13i, 22c, 22c-quote, 22c-inbox,
-- 22c-quotebuild, 22c-quotecard, 22c-done). Re-runnable.
--
-- Services flips the negotiation: the BUYER sends a structured quote request, the
-- PROVIDER answers with the first price (a quote). A quote is a deal born in
-- COUNTERED_BY_SELLER — "awaiting the buyer" — so accept / counter / pay / escrow /
-- "job done" (hand_off) / confirm-and-release all ride the existing machine.
-- Milestone (staged) quotes are a later step and are not in this migration.

-- ── Lane ─────────────────────────────────────────────────────────────────────
alter table public.listings drop constraint if exists listings_lane_check;
alter table public.listings
  add constraint listings_lane_check check (lane in ('goods', 'property', 'vehicles', 'services'));

-- ── Deal terms ───────────────────────────────────────────────────────────────
-- What a service quote is FOR: { service, scope, startsAt }. Null on goods deals.
-- The API also reads startsAt to stretch the escrow hand-off clock to the job date.
alter table public.deals add column if not exists terms jsonb;

-- ── Genesis guard: a provider's quote is the second legal way to open a deal ───
create or replace function public.deal_events_guard() returns trigger language plpgsql as $$
begin
  if new.from_state is null then
    if not ((new.action = 'offer' and new.to_state = 'OFFERED' and new.actor = 'BUYER')
         or (new.action = 'quote' and new.to_state = 'COUNTERED_BY_SELLER' and new.actor = 'SELLER')) then
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

-- ── Quote requests (22c-quote) ───────────────────────────────────────────────
-- The buyer's brief. Lives in the (listing, buyer) conversation; at most one OPEN
-- request per thread. deal_id links the quote that answered it; the provider's
-- inbox (22c-inbox) derives New / Quoted / Scheduled from it.
create table if not exists public.quote_requests (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations (id) on delete cascade,
  listing_id      uuid        not null references public.listings (id) on delete cascade,
  buyer_id        uuid        not null references auth.users (id) on delete cascade,
  seller_id       uuid        not null references auth.users (id) on delete cascade,
  service         text        not null check (char_length(service) between 1 and 120),
  description     text        not null check (char_length(description) between 1 and 2000),
  location        text        check (char_length(location) <= 120),
  state           text,
  city            text,
  preferred       text        check (char_length(preferred) <= 80),
  image_paths     text[]      not null default '{}' check (cardinality(image_paths) <= 6),
  deal_id         uuid        references public.deals (id) on delete set null,
  status          text        not null default 'open' check (status in ('open', 'closed')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (buyer_id <> seller_id)
);
create unique index if not exists quote_requests_one_open
  on public.quote_requests (conversation_id) where status = 'open';
create index if not exists quote_requests_seller_idx
  on public.quote_requests (seller_id, created_at desc);

drop trigger if exists quote_requests_touch_updated_at on public.quote_requests;
create trigger quote_requests_touch_updated_at
  before update on public.quote_requests
  for each row execute function public.touch_updated_at();

-- Parties read (Realtime); every write goes through the API (service role).
alter table public.quote_requests enable row level security;
drop policy if exists quote_requests_party_select on public.quote_requests;
create policy quote_requests_party_select on public.quote_requests
  for select to authenticated using (auth.uid() in (buyer_id, seller_id));
revoke insert, update, delete on public.quote_requests from anon, authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.quote_requests; exception when duplicate_object then null; end;
  end if;
end $$;

-- Browse the lane by category (Home services → Plumbing).
create index if not exists listings_services_category_idx
  on public.listings (category, created_at desc) where lane = 'services' and status = 'active';
