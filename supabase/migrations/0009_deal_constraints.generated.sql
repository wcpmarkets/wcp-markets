-- GENERATED from src/deals/machine.ts by scripts/gen-deal-guard.ts — DO NOT EDIT.
-- Regenerate with `pnpm gen`; CI fails on drift. Applies after 0007 (needs deals).

-- At most one ACTIVE (non-terminal) deal per (listing, buyer). A DB backstop under
-- createOffer's app-level dedupe. Predicate lists the terminal states literally so
-- it stays in lockstep with machine.ts TERMINAL_STATES. Shortlet bookings are exempt:
-- one guest may hold several stays at one place (their dates can't overlap — the
-- bookings exclusion constraint guards that instead).
-- Dropped and recreated so a changed predicate actually lands (create-if-not-exists
-- would keep the old one); cheap at this table size, and still safe to re-run.
drop index if exists public.deals_one_active_per_buyer;
create unique index deals_one_active_per_buyer
  on public.deals (listing_id, buyer_id)
  where state not in ('WITHDRAWN', 'DECLINED', 'EXPIRED', 'COMPLETED', 'REFUNDED', 'CANCELLED')
    and (terms is null or not (terms ? 'booking'));
