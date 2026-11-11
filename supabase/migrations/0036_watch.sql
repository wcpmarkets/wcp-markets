-- Phase 3K — Saved & watches (design 20k, 21a "Watch this search for me", 20l Deals ✦).
--
--   saved_listings  ♡ moves server-side, remembering the price when saved, so the app
--                   can say "↓ ₦15k since saved" and the consumer can tell savers when
--                   it drops.
--   watches         a search kept running: the same parameters /listings/search takes
--                   (routes/listings.ts searchWhere), with maxPrice as the ceiling.
--   watch_hits      a listing that matched a watch — once per (watch, listing), so a
--                   price wobble doesn't re-ping.
--
-- A listing going live or changing price emits 'listing.priced' to the outbox; the
-- consumer (notify/watch.ts) does the matching and the pushing (topic 'watch').
create table if not exists public.saved_listings (
  user_id            uuid   not null references auth.users (id) on delete cascade,
  listing_id         uuid   not null references public.listings (id) on delete cascade,
  price_at_save_kobo bigint not null check (price_at_save_kobo >= 0),
  created_at         timestamptz not null default now(),
  primary key (user_id, listing_id)
);
create index if not exists saved_listings_listing_idx on public.saved_listings (listing_id);
alter table public.saved_listings enable row level security;
drop policy if exists saved_select_own on public.saved_listings;
create policy saved_select_own on public.saved_listings for select using (auth.uid() = user_id);

create table if not exists public.watches (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  -- What the user asked, as shown back to them ("iPhone 14 Pro under ₦400k · Yaba").
  label        text not null check (char_length(label) between 1 and 160),
  -- SearchParams: { q?, lane?, category?, state?, city?, maxPrice?, … }.
  params       jsonb not null,
  ceiling_kobo bigint check (ceiling_kobo is null or ceiling_kobo > 0),
  created_at   timestamptz not null default now()
);
create index if not exists watches_user_idx on public.watches (user_id, created_at desc);
-- The consumer narrows candidates by lane/category before running the full match.
create index if not exists watches_lane_cat_idx on public.watches ((params->>'lane'), (params->>'category'));
alter table public.watches enable row level security;
drop policy if exists watches_select_own on public.watches;
create policy watches_select_own on public.watches for select using (auth.uid() = user_id);

create table if not exists public.watch_hits (
  id           bigint generated always as identity primary key,
  watch_id     uuid   not null references public.watches (id) on delete cascade,
  listing_id   uuid   not null references public.listings (id) on delete cascade,
  price_kobo   bigint not null,
  -- Found when the watch was created (shown, not pushed) vs. caught later (pushed).
  notified     boolean not null default false,
  created_at   timestamptz not null default now(),
  dismissed_at timestamptz,
  unique (watch_id, listing_id)
);
alter table public.watch_hits enable row level security;
drop policy if exists watch_hits_select_own on public.watch_hits;
create policy watch_hits_select_own on public.watch_hits for select
  using (exists (select 1 from public.watches w where w.id = watch_id and w.user_id = auth.uid()));

-- A listing became visible at a price, or its price changed while visible.
create or replace function public.listings_priced_outbox() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.status <> 'active' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'active' and new.price_kobo = old.price_kobo then return new; end if;
  insert into public.outbox (topic, payload)
  values ('listing.priced', jsonb_build_object(
    'listingId', new.id,
    'priceKobo', new.price_kobo,
    -- The price it moved from, when it was already visible (null: newly live).
    'oldPriceKobo', case when tg_op = 'UPDATE' and old.status = 'active' then old.price_kobo end));
  return new;
end $$;

drop trigger if exists listings_priced_outbox_trg on public.listings;
create trigger listings_priced_outbox_trg
  after insert or update of price_kobo, status on public.listings
  for each row execute function public.listings_priced_outbox();
