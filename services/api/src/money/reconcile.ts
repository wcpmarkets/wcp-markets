import type { Sql } from "../deals/commands.js";
import { OUTBOX_MAX_ATTEMPTS } from "../deals/sweeper.js";

/**
 * Ledger reconciliation — the named M4→M5 deliverable. With the Mock provider (no
 * external balance store) this checks INTERNAL consistency; the real-partner balance
 * comparison drops in here later behind the same result shape. Invariants:
 *   1. The whole ledger nets to ZERO (every naira is accounted for).
 *   2. Each deal's escrow_holding balance is exactly 0 (settled) or its principal
 *      (held) — never partial, double, or negative. A STAGED job (deal_milestones)
 *      is legitimately partial: there "held" means principal minus the stages whose
 *      release has settled, and nothing else.
 *   3. SETTLEMENT LAG: a TERMINAL deal (COMPLETED/REFUNDED) with funds still in
 *      escrow after a grace period is a STUCK settlement — the seller was never paid
 *      / the buyer never refunded even though the deal reads done. Invariant 2 alone
 *      calls this "valid" (escrow == principal), so it needs its own check.
 *   4. PARKED OUTBOX: escrow commands that exhausted their relay attempts — the
 *      producer-side dead-letter the sweeper promised to surface but never did.
 */
const SETTLEMENT_GRACE_MINS = 15;

export type DriftDeal = { dealId: string; escrowKobo: number; principalKobo: number; state: string };
export type OverdueDeal = { dealId: string; escrowKobo: number; state: string };
export type StuckDispute = { dealId: string; state: string };
export type ReconResult = {
  globalBalanceKobo: number;
  driftDeals: DriftDeal[];
  settlementOverdue: OverdueDeal[];
  parkedOutbox: number;
  disputesOverdue: StuckDispute[];
  payoutsOverdue: string[]; // payout deal ids stuck 'pending'
  negativePayable: string[]; // deal ids with seller_payable < 0 (double-payout tripwire)
  stagesOverdue: { dealId: string; idx: number }[]; // stage releases / deposit returns never settled
};

const PAYOUT_GRACE_MINS = 30;

// DISPUTED should clear within 24h (auto_refund) and DISPUTED_RESPONDED is a human
// queue — neither has a settlement-lag alarm (invariant 3 is terminal-only), so a
// dispute holding buyer funds can otherwise sit unmonitored forever.
const DISPUTE_SLA_HOURS = 48;

export async function reconcile(db: Sql): Promise<ReconResult> {
  const [g] = await db<{ total: string }[]>`
    select coalesce(sum(amount_kobo), 0)::bigint as total from public.ledger_entries
  `;
  const drift = await db<{ deal_id: string; esc: string; principal: string; state: string }[]>`
    select le.deal_id, sum(le.amount_kobo)::bigint as esc, d.price_kobo::bigint as principal, d.state
    from public.ledger_entries le
    join public.deals d on d.id = le.deal_id
    left join lateral (
      -- Stages that have left escrow either way: released to the seller/host, or
      -- returned to the buyer while the deal lived on (a deposit, a cancelled stay).
      select coalesce(sum(m.amount_kobo), 0) as released
      from public.deal_milestones m where m.deal_id = d.id and m.status in ('released', 'refunded')
    ) st on true
    where le.account = 'escrow_holding'
    group by le.deal_id, d.price_kobo, d.state, st.released
    having sum(le.amount_kobo) not in (0, d.price_kobo - st.released)
  `;
  const overdue = await db<{ deal_id: string; esc: string; state: string }[]>`
    select le.deal_id, sum(le.amount_kobo)::bigint as esc, d.state
    from public.ledger_entries le
    join public.deals d on d.id = le.deal_id
    where le.account = 'escrow_holding' and d.state in ('COMPLETED', 'REFUNDED', 'CANCELLED')
    group by le.deal_id, d.state, d.updated_at
    having sum(le.amount_kobo) <> 0 and d.updated_at < now() - make_interval(mins => ${SETTLEMENT_GRACE_MINS})
  `;
  const [parked] = await db<{ n: number }[]>`
    select count(*)::int as n from public.outbox
    where relayed_at is null and attempts >= ${OUTBOX_MAX_ATTEMPTS}
  `;
  const disputes = await db<{ deal_id: string; state: string }[]>`
    select id as deal_id, state from public.deals
    where state in ('DISPUTED', 'DISPUTED_RESPONDED')
      and updated_at < now() - make_interval(hours => ${DISPUTE_SLA_HOURS})
  `;
  // (6) A payout stuck 'pending' past the grace = the seller is owed and unpaid, with
  // no other alarm watching it (escrow=0, deal terminal). (7) seller_payable < 0 on
  // any deal = a double-payout already happened (the direct tripwire for settlePayout).
  const payoutsStuck = await db<{ deal_id: string }[]>`
    select deal_id from public.payouts
    where status = 'pending' and created_at < now() - make_interval(mins => ${PAYOUT_GRACE_MINS})
  `;
  // (8) A stage whose release was requested but never settled — the provider was
  // told the money was on its way. Non-terminal deals escape invariant 3, so watch it.
  const stagesStuck = await db<{ deal_id: string; idx: number }[]>`
    select deal_id, idx from public.deal_milestones
    where status in ('releasing', 'refunding') and updated_at < now() - make_interval(mins => ${SETTLEMENT_GRACE_MINS})
  `;
  const negPayable = await db<{ deal_id: string }[]>`
    select deal_id from public.ledger_entries where account = 'seller_payable'
    group by deal_id having sum(amount_kobo) < 0
  `;
  return {
    globalBalanceKobo: Number(g!.total),
    driftDeals: drift.map((r) => ({ dealId: r.deal_id, escrowKobo: Number(r.esc), principalKobo: Number(r.principal), state: r.state })),
    settlementOverdue: overdue.map((r) => ({ dealId: r.deal_id, escrowKobo: Number(r.esc), state: r.state })),
    parkedOutbox: parked!.n,
    disputesOverdue: disputes.map((r) => ({ dealId: r.deal_id, state: r.state })),
    payoutsOverdue: payoutsStuck.map((r) => r.deal_id),
    negativePayable: negPayable.map((r) => r.deal_id),
    stagesOverdue: stagesStuck.map((r) => ({ dealId: r.deal_id, idx: r.idx })),
  };
}

/**
 * Run reconciliation and DURABLY record any anomaly (deduped per deal on the open
 * reconciliation_exceptions), logging an error line a metric-filter alarm can page on.
 * Returns the result for the caller to log a summary.
 */
export async function reconcileAndRecord(db: Sql): Promise<ReconResult> {
  const r = await reconcile(db);
  const bad =
    r.globalBalanceKobo !== 0 ||
    r.driftDeals.length > 0 ||
    r.settlementOverdue.length > 0 ||
    r.parkedOutbox > 0 ||
    r.disputesOverdue.length > 0 ||
    r.payoutsOverdue.length > 0 ||
    r.negativePayable.length > 0 ||
    r.stagesOverdue.length > 0;
  if (!bad) return r;

  console.error(
    `[reconcile] ANOMALY — global=${r.globalBalanceKobo} drift=${r.driftDeals.length} ` +
      `overdue=${r.settlementOverdue.length} parkedOutbox=${r.parkedOutbox} disputesOverdue=${r.disputesOverdue.length} ` +
      `payoutsOverdue=${r.payoutsOverdue.length} negativePayable=${r.negativePayable.length}`,
  );

  const record = (dealId: string | null, kind: string, detail: string) => db`
    insert into public.reconciliation_exceptions (deal_id, kind, detail)
    select ${dealId}, ${kind}, ${detail}
    where not exists (
      select 1 from public.reconciliation_exceptions
      where kind = ${kind} and deal_id is not distinct from ${dealId} and resolved_at is null
    )
  `;

  for (const d of r.driftDeals.slice(0, 50)) {
    await record(d.dealId, "ledger_drift", `escrow=${d.escrowKobo} principal=${d.principalKobo} state=${d.state}`);
  }
  for (const d of r.settlementOverdue.slice(0, 50)) {
    await record(d.dealId, "settlement_overdue", `escrow=${d.escrowKobo} state=${d.state} (>${SETTLEMENT_GRACE_MINS}m)`);
  }
  for (const d of r.disputesOverdue.slice(0, 50)) {
    await record(d.dealId, "dispute_sla_overdue", `state=${d.state} (>${DISPUTE_SLA_HOURS}h, funds held)`);
  }
  for (const dealId of r.payoutsOverdue.slice(0, 50)) {
    await record(dealId, "payout_overdue", `payout stuck 'pending' >${PAYOUT_GRACE_MINS}m — seller unpaid`);
  }
  for (const dealId of r.negativePayable.slice(0, 50)) {
    await record(dealId, "negative_seller_payable", "seller_payable < 0 — likely double-payout");
  }
  for (const st of r.stagesOverdue.slice(0, 50)) {
    await record(st.dealId, "stage_release_overdue", `stage ${st.idx} 'releasing' >${SETTLEMENT_GRACE_MINS}m — provider unpaid`);
  }
  if (r.globalBalanceKobo !== 0) await record(null, "ledger_global_imbalance", `total=${r.globalBalanceKobo}`);
  if (r.parkedOutbox > 0) await record(null, "outbox_parked", `count=${r.parkedOutbox} (attempts>=${OUTBOX_MAX_ATTEMPTS})`);

  return r;
}
