-- Phase 2 M1 — Goods listings + a private image bucket.
-- Same convention as 0003: RLS on; the service-role API owns writes. `lane` and
-- `category` are SEPARATE first-class fields (the spec's central architectural
-- decision — route on transaction model, not topic). M1 is Goods-only: a CHECK
-- pins lane='goods'; other lanes relax it in a later migration.

-- ── Listings ────────────────────────────────────────────────────────────────
create table if not exists public.listings (
  id           uuid        primary key default gen_random_uuid(),
  seller_id    uuid        not null references auth.users (id) on delete cascade,
  lane         text        not null default 'goods' check (lane = 'goods'),
  category     text        not null check (char_length(category) between 1 and 64),
  title        text        not null check (char_length(title) between 1 and 140),
  description  text        check (description is null or char_length(description) <= 4000),
  -- Money is ALWAYS integer minor units (kobo), never a float. bigint headroom.
  price_kobo   bigint      not null check (price_kobo >= 0),
  currency     text        not null default 'NGN' check (currency = 'NGN'),
  negotiable   boolean     not null default true,
  stock        integer     not null default 1 check (stock >= 0),
  condition    text        not null default 'used' check (condition in ('new', 'used', 'refurbished')),
  location     text        check (location is null or char_length(location) <= 120),
  -- Storage object keys in the private `listing-images` bucket (Goods cap = 10).
  image_paths  text[]      not null default '{}' check (array_length(image_paths, 1) is null or array_length(image_paths, 1) <= 10),
  status       text        not null default 'active' check (status in ('draft', 'active', 'sold', 'archived')),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- Browse the newest active listings; a seller's own dashboard.
create index if not exists listings_active_recent_idx
  on public.listings (created_at desc) where status = 'active';
create index if not exists listings_seller_idx
  on public.listings (seller_id, created_at desc);
create index if not exists listings_category_idx
  on public.listings (category) where status = 'active';

alter table public.listings enable row level security;

-- Direct-read policies (defense-in-depth; the API reads via the service role).
-- Anyone may see ACTIVE listings; an owner also sees their own drafts/archived.
drop policy if exists listings_select_active on public.listings;
create policy listings_select_active on public.listings
  for select using (status = 'active');

drop policy if exists listings_select_own on public.listings;
create policy listings_select_own on public.listings
  for select using (auth.uid() = seller_id);

-- No client insert/update/delete policies: all writes go through the service-role
-- API (which bypasses RLS) so business rules live in one auditable place.

-- Keep updated_at honest even if a write ever bypasses the API's explicit set.
create or replace function public.touch_updated_at()
  returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists listings_touch_updated_at on public.listings;
create trigger listings_touch_updated_at
  before update on public.listings
  for each row execute function public.touch_updated_at();

-- ── Private image bucket ─────────────────────────────────────────────────────
-- Private: clients never touch Storage directly. The API (service role) mints
-- short-lived SIGNED upload URLs (owner-scoped path `{seller_id}/{listing_id}/…`)
-- and signed download URLs on read. No client-facing storage.objects policies are
-- needed for that flow; a signed token authorizes the specific object.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'listing-images', 'listing-images', false,
  5242880,                                   -- 5 MB per image
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;
