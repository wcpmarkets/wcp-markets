-- Phase 2 M2 — search/browse: Postgres full-text search + fuzzy (trigram)
-- matching over listings. NO AI/vectors — plain FTS + pg_trgm, ranked. Filters
-- (category, price, condition, location) compose in the API query.

-- Trigram matching for typo tolerance on titles ("iphone" ~ "ihpone").
create extension if not exists pg_trgm;

-- Weighted FTS document: title (A) > category (B) > description (C). A stored
-- generated column keeps it in sync automatically; to_tsvector with a constant
-- config is immutable, so it's valid here.
alter table public.listings
  add column if not exists search_vector tsvector
  generated always as (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(category, '')), 'B') ||
    setweight(to_tsvector('english', coalesce(description, '')), 'C')
  ) stored;

create index if not exists listings_search_idx
  on public.listings using gin (search_vector);

create index if not exists listings_title_trgm_idx
  on public.listings using gin (title gin_trgm_ops);
