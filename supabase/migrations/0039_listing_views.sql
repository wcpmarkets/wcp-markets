-- Seller ad stats (design 13c-detail): views per listing per day.
--
-- A count only — no viewer id, IP or device — so nothing here is personal data and it
-- needs no retention rule beyond the listing's own life (cascade). GET /listings/{id}
-- bumps today's row for any reader except the listing's own seller.
create table if not exists public.listing_views_daily (
  listing_id uuid not null references public.listings (id) on delete cascade,
  day        date not null default (now() at time zone 'Africa/Lagos')::date,
  views      integer not null default 0 check (views >= 0),
  primary key (listing_id, day)
);
-- API-only (service connection); no client reads it directly.
alter table public.listing_views_daily enable row level security;
