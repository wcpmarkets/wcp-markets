import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TRANSITIONS, DEAL_STATES, TERMINAL_STATES } from "../src/deals/machine.js";

/**
 * Generate the Postgres transition-guard from the TS machine (the single source of
 * truth). Emits `public.deal_next_state(from, actor, action) -> to_state`: it
 * returns the legal next state or NULL. The M3 deals migration installs this plus a
 * trigger that rejects any illegal transition at the DB layer — so even a buggy app
 * can never write one. Committed + drift-checked via `pnpm gen` (like the OpenAPI
 * artifact), so the DB guard can never silently diverge from the app's map.
 */
// Emitted as numbered migrations so they apply in order: the guard FUNCTIONS
// (0006) before the deals schema that references them (0007), and the CONSTRAINTS
// that reference the deals table (0009) after it. All idempotent, so regenerating
// on every machine.ts change is safe.
const here = dirname(fileURLToPath(import.meta.url));
const migrations = resolve(here, "../../../supabase/migrations");
const out = resolve(migrations, "0006_deal_guard.generated.sql");
const constraintsOut = resolve(migrations, "0009_deal_constraints.generated.sql");

const rows = TRANSITIONS.map(
  (t) => `    ('${t.from}', '${t.actor}', '${t.action}', '${t.to}')`,
).join(",\n");

const states = DEAL_STATES.map((s) => `'${s}'`).join(", ");
const terminals = TERMINAL_STATES.map((s) => `'${s}'`).join(", ");

const sql = `-- GENERATED from src/deals/machine.ts by scripts/gen-deal-guard.ts — DO NOT EDIT.
-- Regenerate with \`pnpm gen\`; CI fails on drift.

-- All valid deal states (for the CHECK on deals.state / deal_events.to_state).
create or replace function public.deal_states() returns text[] language sql immutable as $$
  select array[${states}]::text[];
$$;

create or replace function public.deal_terminal_states() returns text[] language sql immutable as $$
  select array[${terminals}]::text[];
$$;

-- The transition table, materialised as a function. Returns the resulting state for
-- a (from, actor, action), or NULL when the transition is illegal.
create or replace function public.deal_next_state(p_from text, p_actor text, p_action text)
returns text language sql immutable as $$
  select to_state from (values
${rows}
  ) as t(from_state, actor, action, to_state)
  where from_state = p_from and actor = p_actor and action = p_action;
$$;
`;

writeFileSync(out, sql, "utf8");

// Constraints that reference the deals TABLE (so they apply after 0007). The
// one-active-deal partial-unique index is generated from TERMINAL_STATES so its
// predicate can never drift from the machine (Fable review #5).
const constraintsSql = `-- GENERATED from src/deals/machine.ts by scripts/gen-deal-guard.ts — DO NOT EDIT.
-- Regenerate with \`pnpm gen\`; CI fails on drift. Applies after 0007 (needs deals).

-- At most one ACTIVE (non-terminal) deal per (listing, buyer). A DB backstop under
-- createOffer's app-level dedupe. Predicate lists the terminal states literally so
-- it stays in lockstep with machine.ts TERMINAL_STATES.
create unique index if not exists deals_one_active_per_buyer
  on public.deals (listing_id, buyer_id)
  where state not in (${terminals});
`;
writeFileSync(constraintsOut, constraintsSql, "utf8");

// eslint-disable-next-line no-console
console.log(`[deal-guard] wrote ${out} (${TRANSITIONS.length} transitions) + ${constraintsOut}`);
