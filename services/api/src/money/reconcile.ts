import type { Sql } from "../deals/commands.js";

/**
 * Ledger reconciliation — the named M4→M5 deliverable. With the Mock provider (no
 * external balance store) this checks INTERNAL consistency; the real-partner balance
 * comparison drops in here later behind the same result shape. Two invariants:
 *   1. The whole ledger nets to ZERO (every naira is accounted for).
 *   2. Each deal's escrow_holding balance is exactly 0 (settled) or its principal
 *      (held) — never partial, double, or negative. This holds regardless of
 *      settlement timing (a COMPLETED deal awaiting release.settled still reads
 *      +principal, which is valid), so in-flight settlements don't false-positive.
 */
export type DriftDeal = {
  dealId: string;
  escrowKobo: number;
  principalKobo: number;
  state: string;
};
export type ReconResult = { globalBalanceKobo: number; driftDeals: DriftDeal[] };

export async function reconcile(db: Sql): Promise<ReconResult> {
  const [g] = await db<{ total: string }[]>`
    select coalesce(sum(amount_kobo), 0)::bigint as total from public.ledger_entries
  `;
  const drift = await db<{ deal_id: string; esc: string; principal: string; state: string }[]>`
    select le.deal_id, sum(le.amount_kobo)::bigint as esc, d.price_kobo::bigint as principal, d.state
    from public.ledger_entries le
    join public.deals d on d.id = le.deal_id
    where le.account = 'escrow_holding'
    group by le.deal_id, d.price_kobo, d.state
    having sum(le.amount_kobo) not in (0, d.price_kobo)
  `;
  return {
    globalBalanceKobo: Number(g!.total),
    driftDeals: drift.map((r) => ({
      dealId: r.deal_id,
      escrowKobo: Number(r.esc),
      principalKobo: Number(r.principal),
      state: r.state,
    })),
  };
}

/**
 * Run reconciliation and DURABLY record any drift (deduped per deal on the open
 * reconciliation_exceptions), logging an error line a metric-filter alarm can page on.
 * Returns the result for the caller to log a summary.
 */
export async function reconcileAndRecord(db: Sql): Promise<ReconResult> {
  const r = await reconcile(db);
  const drifting = r.globalBalanceKobo !== 0 || r.driftDeals.length > 0;
  if (drifting) {
    console.error(
      `[reconcile] LEDGER DRIFT — global=${r.globalBalanceKobo} driftDeals=${r.driftDeals.length}`,
    );
    for (const d of r.driftDeals.slice(0, 50)) {
      const detail = `escrow=${d.escrowKobo} principal=${d.principalKobo} state=${d.state}`;
      await db`
        insert into public.reconciliation_exceptions (deal_id, kind, detail)
        select ${d.dealId}, 'ledger_drift', ${detail}
        where not exists (
          select 1 from public.reconciliation_exceptions
          where deal_id = ${d.dealId} and kind = 'ledger_drift' and resolved_at is null
        )
      `;
    }
    if (r.globalBalanceKobo !== 0) {
      await db`
        insert into public.reconciliation_exceptions (deal_id, kind, detail)
        select null, 'ledger_global_imbalance', ${`total=${r.globalBalanceKobo}`}
        where not exists (
          select 1 from public.reconciliation_exceptions
          where kind = 'ledger_global_imbalance' and resolved_at is null
        )
      `;
    }
  }
  return r;
}
