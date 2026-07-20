-- Phase 2 M3 — align the outbox index with the relay's access pattern.
-- The sweeper relays with `where relayed_at is null and attempts < N order by id`
-- (keyset cursor on id), so the partial index should be on id, not created_at.
drop index if exists public.outbox_unrelayed_idx;
create index if not exists outbox_unrelayed_idx
  on public.outbox (id) where relayed_at is null;
