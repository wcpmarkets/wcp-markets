-- Second lane: Property. The transaction spine (offer → escrow → chat → order) is
-- lane-agnostic and unchanged; only the listing gains a lane and a bag of
-- lane-specific facets. Relax the goods-only CHECK and add a JSONB attribute set
-- (the spec's "lane-specific facets as a JSON/EAV attribute set").
--
-- Goods columns (condition, stock) stay as-is: property listings just carry their
-- harmless defaults and ignore them. Property's own facets live in `attributes`
-- (propertyType, dealType rent|sale, beds, baths), validated by the API per lane.

alter table public.listings drop constraint if exists listings_lane_check;
alter table public.listings
  add constraint listings_lane_check check (lane in ('goods', 'property'));

alter table public.listings
  add column if not exists attributes jsonb not null default '{}'::jsonb;

-- Browse within a lane (Homes tab, Buy tab): active listings by lane, newest first.
create index if not exists listings_lane_active_recent_idx
  on public.listings (lane, created_at desc) where status = 'active';
