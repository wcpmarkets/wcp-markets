import { randomUUID } from "node:crypto";
import type { Tx } from "../deals/commands.js";

/**
 * Double-entry ledger writers. Each writes ONE balanced txn_group (sum = 0, enforced
 * by the deferred DB trigger) inside the caller's transaction. Signed kobo: positive
 * credits the account. Called from the deal EFFECTS, so they inherit the transition's
 * idempotency (a replayed event never re-runs the effect).
 */

/** Buyer pays principal + fee → funds captured into escrow, fee to WCP. */
export async function writeHold(
  sql: Tx,
  p: { dealId: string; seq: number; principal: number; fee: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, event_seq, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, ${p.seq}, 'external',       ${-(p.principal + p.fee)}, 'hold', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'escrow_holding', ${p.principal},            'hold', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'wcp_fees',       ${p.fee},                  'hold', ${p.providerRef})
  `;
}

/** Reverse a hold back to the buyer (oversold / dispute / seller-cancel). Full make-whole. */
export async function writeRefund(
  sql: Tx,
  p: { dealId: string; seq: number; principal: number; fee: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, event_seq, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, ${p.seq}, 'escrow_holding', ${-p.principal},         'refund', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'wcp_fees',       ${-p.fee},               'refund', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'external',       ${p.principal + p.fee},  'refund', ${p.providerRef})
  `;
}
