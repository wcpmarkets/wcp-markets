-- 0020 — structured location on listings.
--
-- `location` was one free-text field ("Ikeja, Lagos", "GRA, Port Harcourt"), which
-- can't be grouped, counted or measured. Browsing is location-first, so a listing
-- now carries the state and area it belongs to (validated by the API against the
-- canonical list in services/api/src/data/ng-regions.ts) plus the seller's coarse
-- point, which is what makes the 5/10/25 km ring mean anything.
--
-- The free-text column stays: it's what sellers typed, it's what the card shows,
-- and it's the fallback for rows predating this migration.
--
-- earthdistance (on cube) rather than PostGIS: we need one operation — "is this
-- point within N km of that point" — and it ships with a GiST index for it at a
-- fraction of the footprint.

create extension if not exists cube;
create extension if not exists earthdistance;

alter table public.listings
  add column if not exists state text,
  add column if not exists city  text,
  add column if not exists lat   double precision,
  add column if not exists lng   double precision;

do $$
begin
  -- A half-set coordinate is worse than none: it would silently drop out of every
  -- radius query while looking populated.
  if not exists (select 1 from pg_constraint where conname = 'listings_latlng_pair') then
    alter table public.listings
      add constraint listings_latlng_pair check ((lat is null) = (lng is null));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'listings_latlng_range') then
    alter table public.listings
      add constraint listings_latlng_range check (
        lat is null or (lat between -90 and 90 and lng between -180 and 180)
      );
  end if;
  if not exists (select 1 from pg_constraint where conname = 'listings_state_len') then
    alter table public.listings
      add constraint listings_state_len check (
        (state is null or char_length(state) <= 64) and
        (city is null or char_length(city) <= 64)
      );
  end if;
end $$;

-- Browse is always "active listings in <state>" or "... in <state>/<city>".
create index if not exists listings_state_idx
  on public.listings (state, created_at desc) where status = 'active';
create index if not exists listings_state_city_idx
  on public.listings (state, city, created_at desc) where status = 'active';

-- The radius ring. Partial: only located rows can ever match a distance query.
create index if not exists listings_earth_idx
  on public.listings using gist (ll_to_earth(lat, lng))
  where status = 'active' and lat is not null;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Rows created before this migration only have free text. Map the shapes we
-- actually shipped ("<Area>, <State>" and "<Area>, <City>") onto the canonical
-- pairs; anything unrecognised keeps null state/city and shows up only under
-- "Nationwide", which is the honest answer for a listing we can't place.
-- Coordinates here are the area centres — a seller's own fix is captured going
-- forward, but back-dated rows have none.
-- `prio` orders the patterns explicitly: the area needles are tried before the
-- bare state catch-alls, so "Yaba, Lagos" lands on Yaba, not Ikeja.
with known (prio, needle, s, c, la, lo) as (
  values
    (1,  '%ikeja%',          'Lagos',       'Ikeja',           6.602,  3.352),
    (2,  '%lekki%',          'Lagos',       'Lekki',           6.470,  3.585),
    (3,  '%yaba%',           'Lagos',       'Yaba',            6.510,  3.371),
    (4,  '%surulere%',       'Lagos',       'Surulere',        6.492,  3.354),
    (5,  '%victoria island%','Lagos',       'Victoria Island', 6.428,  3.424),
    (6,  '%wuse%',           'Abuja (FCT)', 'Wuse',            9.076,  7.470),
    (7,  '%garki%',          'Abuja (FCT)', 'Garki',           9.032,  7.489),
    (8,  '%port harcourt%',  'Rivers',      'Port Harcourt',   4.816,  7.050),
    (9,  '%bodija%',         'Oyo',         'Bodija',          7.431,  3.901),
    (10, '%ibadan%',         'Oyo',         'Ibadan',          7.378,  3.947),
    (11, '%benin city%',     'Edo',         'Benin City',      6.335,  5.628),
    (12, '%enugu%',          'Enugu',       'Enugu',           6.459,  7.548),
    (13, '%kano%',           'Kano',        'Kano',           12.000,  8.516),
    (14, '%abuja%',          'Abuja (FCT)', 'Central Area',    9.058,  7.492),
    (15, '%lagos%',          'Lagos',       'Ikeja',           6.602,  3.352)
)
update public.listings l
set state = k.s, city = k.c, lat = k.la, lng = k.lo
from (
  select distinct on (li.id) li.id, kn.s, kn.c, kn.la, kn.lo
  from public.listings li
  join known kn on lower(li.location) like kn.needle
  where li.state is null and li.location is not null
  order by li.id, kn.prio
) k
where l.id = k.id;
