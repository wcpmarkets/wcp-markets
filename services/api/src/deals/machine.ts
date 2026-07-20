/**
 * The deal/offer state machine — the deterministic, auditable CORE of WCP.
 *
 * This const map is the SINGLE SOURCE OF TRUTH. It drives the API command handler
 * AND generates the Postgres transition-guard (scripts/gen-deal-guard.ts →
 * deal-guard.generated.sql), so the app and the database can never disagree about
 * which transitions are legal. Absolutely NO AI and NO money-math live here — only
 * "given this state + this actor + this action, what is the next state?".
 *
 * A deal is born in OFFERED (genesis, not a transition). Every subsequent change is
 * one row appended to `deal_events`; `deals.state` is written in the SAME tx as the
 * event (event-sourcing-lite — the log is the audit trail, the column is the fold).
 *
 * States are kept deliberately LEAN (13): each state is a row, a test, and UI in
 * every client, so anything that is really a flag/timestamp on another state was
 * audited out (e.g. WHY a deal expired lives on the terminating event, not in a
 * separate state).
 *
 * Milestone tags below show where each transition is *implemented*; the full map is
 * defined now so the generated DB guard is complete from the start. M3 (this
 * milestone) wires the negotiation transitions only — no money.
 */

export const DEAL_STATES = [
  // ── Negotiation (M3) ──
  "OFFERED", // buyer offered; awaiting seller (4h)
  "COUNTERED_BY_SELLER", // awaiting buyer (4h)
  "COUNTERED_BY_BUYER", // awaiting seller (4h)
  "ACCEPTED", // agreed; awaiting buyer payment (4h)
  // ── Money / fulfilment (M4–M6) ──
  "PAYMENT_PENDING", // buyer paid; awaiting escrow webhook
  "PAID_IN_ESCROW", // funds held; stock decremented; awaiting hand-off
  "HANDED_OFF", // seller handed off; 48h auto-release to buyer confirm
  "DISPUTED", // buyer opened a dispute; 24h seller-response clock → auto-refund
  "DISPUTED_RESPONDED", // seller responded → clock stops; awaiting admin resolution
  // ── Terminal ──
  "WITHDRAWN", // buyer pulled out
  "DECLINED", // seller declined
  "EXPIRED", // a deadline lapsed (reason is on the event)
  "COMPLETED", // released to seller (happy path)
  "REFUNDED", // returned to buyer (dispute / oversold / seller-cancel)
] as const;
export type DealState = (typeof DEAL_STATES)[number];

export const TERMINAL_STATES = [
  "WITHDRAWN",
  "DECLINED",
  "EXPIRED",
  "COMPLETED",
  "REFUNDED",
] as const satisfies readonly DealState[];

// ADMIN is distinct from SYSTEM so the audit log records WHICH human resolved a
// dispute (SYSTEM = timers/webhooks; ADMIN = a person's decision). Also the authz gate.
export const ACTORS = ["BUYER", "SELLER", "ADMIN", "SYSTEM"] as const;
export type Actor = (typeof ACTORS)[number];

export const DEAL_ACTIONS = [
  "offer", // genesis only (creates the deal in OFFERED) — not in the table
  "counter",
  "accept",
  "decline",
  "withdraw", // buyer backs out
  "cancel", // seller backs out of an ACCEPTED-but-unpaid deal (reneged; trust signal)
  "pay",
  "payment_confirmed",
  "payment_failed",
  "oversold",
  "hand_off",
  "confirm_receipt",
  "auto_release",
  "dispute",
  "respond", // seller responds to a dispute (stops the 24h clock; → awaiting admin)
  "resolve_release",
  "resolve_refund",
  "auto_refund",
  "cancel_refund",
  "expire",
] as const;
export type DealAction = (typeof DEAL_ACTIONS)[number];

export type Milestone = "M3" | "M4" | "M5" | "M6";

export type Transition = {
  from: DealState;
  actor: Actor;
  action: DealAction;
  to: DealState;
  milestone: Milestone;
};

/** Every legal transition. Genesis ("offer" → OFFERED) is handled by the creator. */
export const TRANSITIONS: readonly Transition[] = [
  // ── Negotiation (M3) ──────────────────────────────────────────────────────
  { from: "OFFERED", actor: "SELLER", action: "accept", to: "ACCEPTED", milestone: "M3" },
  { from: "OFFERED", actor: "SELLER", action: "counter", to: "COUNTERED_BY_SELLER", milestone: "M3" },
  { from: "OFFERED", actor: "SELLER", action: "decline", to: "DECLINED", milestone: "M3" },
  { from: "OFFERED", actor: "BUYER", action: "withdraw", to: "WITHDRAWN", milestone: "M3" },
  { from: "OFFERED", actor: "SYSTEM", action: "expire", to: "EXPIRED", milestone: "M3" },

  { from: "COUNTERED_BY_SELLER", actor: "BUYER", action: "accept", to: "ACCEPTED", milestone: "M3" },
  { from: "COUNTERED_BY_SELLER", actor: "BUYER", action: "counter", to: "COUNTERED_BY_BUYER", milestone: "M3" },
  { from: "COUNTERED_BY_SELLER", actor: "BUYER", action: "withdraw", to: "WITHDRAWN", milestone: "M3" },
  { from: "COUNTERED_BY_SELLER", actor: "SYSTEM", action: "expire", to: "EXPIRED", milestone: "M3" },

  { from: "COUNTERED_BY_BUYER", actor: "SELLER", action: "accept", to: "ACCEPTED", milestone: "M3" },
  { from: "COUNTERED_BY_BUYER", actor: "SELLER", action: "counter", to: "COUNTERED_BY_SELLER", milestone: "M3" },
  { from: "COUNTERED_BY_BUYER", actor: "SELLER", action: "decline", to: "DECLINED", milestone: "M3" },
  { from: "COUNTERED_BY_BUYER", actor: "BUYER", action: "withdraw", to: "WITHDRAWN", milestone: "M3" },
  { from: "COUNTERED_BY_BUYER", actor: "SYSTEM", action: "expire", to: "EXPIRED", milestone: "M3" },

  { from: "ACCEPTED", actor: "BUYER", action: "withdraw", to: "WITHDRAWN", milestone: "M3" },
  { from: "ACCEPTED", actor: "SELLER", action: "cancel", to: "DECLINED", milestone: "M3" }, // seller reneges pre-payment
  { from: "ACCEPTED", actor: "SYSTEM", action: "expire", to: "EXPIRED", milestone: "M3" },

  // ── Payment (M4) ──────────────────────────────────────────────────────────
  // NOTE: no expire on PAYMENT_PENDING — once funds are in flight, auto-expiring
  // would strand a captured payment on a terminal deal. A stuck payment is a
  // reconciliation/ops concern, not a timer.
  { from: "ACCEPTED", actor: "BUYER", action: "pay", to: "PAYMENT_PENDING", milestone: "M4" },
  { from: "PAYMENT_PENDING", actor: "SYSTEM", action: "payment_confirmed", to: "PAID_IN_ESCROW", milestone: "M4" },
  { from: "PAYMENT_PENDING", actor: "SYSTEM", action: "payment_failed", to: "ACCEPTED", milestone: "M4" },
  { from: "PAYMENT_PENDING", actor: "SYSTEM", action: "oversold", to: "REFUNDED", milestone: "M4" },

  // ── Fulfilment (M5) ───────────────────────────────────────────────────────
  { from: "PAID_IN_ESCROW", actor: "SELLER", action: "hand_off", to: "HANDED_OFF", milestone: "M5" },
  { from: "PAID_IN_ESCROW", actor: "SELLER", action: "cancel_refund", to: "REFUNDED", milestone: "M5" },
  { from: "PAID_IN_ESCROW", actor: "SYSTEM", action: "auto_refund", to: "REFUNDED", milestone: "M5" }, // hand-off SLA breach
  { from: "HANDED_OFF", actor: "BUYER", action: "confirm_receipt", to: "COMPLETED", milestone: "M5" },
  { from: "HANDED_OFF", actor: "SYSTEM", action: "auto_release", to: "COMPLETED", milestone: "M5" },

  // ── Disputes (M6) ─────────────────────────────────────────────────────────
  { from: "PAID_IN_ESCROW", actor: "BUYER", action: "dispute", to: "DISPUTED", milestone: "M6" },
  { from: "HANDED_OFF", actor: "BUYER", action: "dispute", to: "DISPUTED", milestone: "M6" },
  { from: "DISPUTED", actor: "SYSTEM", action: "auto_refund", to: "REFUNDED", milestone: "M6" }, // 24h silence
  { from: "DISPUTED", actor: "SELLER", action: "respond", to: "DISPUTED_RESPONDED", milestone: "M6" }, // stops the clock
  { from: "DISPUTED", actor: "ADMIN", action: "resolve_release", to: "COMPLETED", milestone: "M6" },
  { from: "DISPUTED", actor: "ADMIN", action: "resolve_refund", to: "REFUNDED", milestone: "M6" },
  // Seller responded → an admin (CX/support) adjudicates; no auto-timer here.
  { from: "DISPUTED_RESPONDED", actor: "ADMIN", action: "resolve_release", to: "COMPLETED", milestone: "M6" },
  { from: "DISPUTED_RESPONDED", actor: "ADMIN", action: "resolve_refund", to: "REFUNDED", milestone: "M6" },
] as const;

/**
 * Deadline set when a deal ENTERS a state — fired later by the SYSTEM actor via the
 * sweeper. Hours are TUNABLE for NG power/data patterns (spec note). A deal in a
 * state absent here has no auto-deadline.
 */
export const DEADLINES: Partial<Record<DealState, { hours: number; action: DealAction }>> = {
  OFFERED: { hours: 4, action: "expire" },
  COUNTERED_BY_SELLER: { hours: 4, action: "expire" },
  COUNTERED_BY_BUYER: { hours: 4, action: "expire" },
  ACCEPTED: { hours: 4, action: "expire" }, // accepted-but-unpaid
  // No deadline on PAYMENT_PENDING by design (see the transitions note).
  PAID_IN_ESCROW: { hours: 72, action: "auto_refund" }, // seller hand-off SLA (buyer protection)
  HANDED_OFF: { hours: 48, action: "auto_release" },
  DISPUTED: { hours: 24, action: "auto_refund" },
};

const INDEX = new Map<string, DealState>();
for (const t of TRANSITIONS) INDEX.set(`${t.from}|${t.actor}|${t.action}`, t.to);

/** The resulting state for a (from, actor, action), or null if the transition is illegal. */
export function nextState(from: DealState, actor: Actor, action: DealAction): DealState | null {
  return INDEX.get(`${from}|${actor}|${action}`) ?? null;
}

export function isTerminal(s: DealState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(s);
}
