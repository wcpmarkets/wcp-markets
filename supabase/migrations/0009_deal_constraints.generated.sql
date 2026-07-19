-- GENERATED from src/deals/machine.ts by scripts/gen-deal-guard.ts — DO NOT EDIT.
-- Regenerate with `pnpm gen`; CI fails on drift. Applies after 0007 (needs deals).

-- At most one ACTIVE (non-terminal) deal per (listing, buyer). A DB backstop under
-- createOffer's app-level dedupe. Predicate lists the terminal states literally so
-- it stays in lockstep with machine.ts TERMINAL_STATES.
create unique index if not exists deals_one_active_per_buyer
  on public.deals (listing_id, buyer_id)
  where state not in ('WITHDRAWN', 'DECLINED', 'EXPIRED', 'COMPLETED', 'REFUNDED');
