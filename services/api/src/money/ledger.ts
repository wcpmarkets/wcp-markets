import { randomUUID } from "node:crypto";
import type { Sql, Tx } from "../deals/commands.js";
import { buyerFeeKobo, sellerFeeKobo } from "./fees.js";

/** A settlement webhook either booked its ledger or was refused (recorded, not booked). */
export type SettleResult = { ok: true } | { ok: false; reason: string };

/**
 * Has this deal already been settled for `movement`? "same" = a redelivery of the
 * same provider ref (idempotent replay); "different" = a SECOND ref for the same deal
 * — a double-settle that the (deal_id, movement, provider_ref, account) idempotency
 * index does NOT catch, so it would double-book. Refuse it.
 */
async function priorSettlement(
  sql: Tx,
  dealId: string,
  movement: string,
  providerRef: string,
): Promise<"none" | "same" | "different"> {
  const [r] = await sql<{ provider_ref: string | null }[]>`
    select provider_ref from public.ledger_entries
    where deal_id = ${dealId} and movement = ${movement} limit 1
  `;
  if (!r) return "none";
  return r.provider_ref === providerRef ? "same" : "different";
}

/** The amount the hold booked for a deal (principal + the fee actually captured),
 * read back from the ledger so refunds reverse exactly what was held. */
async function heldAmount(sql: Tx, dealId: string): Promise<number | null> {
  const [r] = await sql<{ amount: string | null }[]>`
    select (-sum(amount_kobo))::bigint as amount
    from public.ledger_entries
    where deal_id = ${dealId} and movement = 'hold' and account = 'external'
  `;
  return r?.amount != null ? Number(r.amount) : null;
}

/**
 * Double-entry ledger writers. Each writes ONE balanced txn_group (sum = 0, enforced
 * by the deferred DB trigger) inside the caller's transaction. Signed kobo: positive
 * credits the account. `ON CONFLICT DO NOTHING` on the (deal_id, movement,
 * provider_ref, account) idempotency index makes a redelivered settlement webhook a
 * no-op (0 rows → the balance trigger doesn't fire), on top of the transition-layer
 * idempotency the hold path already has.
 */

/** Buyer pays principal + fee → funds captured into escrow, fee to WCP. */
export async function writeHold(
  sql: Tx,
  p: { dealId: string; seq: number | null; principal: number; fee: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, event_seq, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, ${p.seq}, 'external',       ${-(p.principal + p.fee)}, 'hold', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'escrow_holding', ${p.principal},            'hold', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'wcp_fees',       ${p.fee},                  'hold', ${p.providerRef})
    on conflict do nothing
  `;
}

/** Pay the seller their released balance out to their bank: seller_payable → external. */
export async function writePayout(
  sql: Tx,
  p: { dealId: string; amountKobo: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, 'seller_payable', ${-p.amountKobo}, 'payout', ${p.providerRef}),
      (${grp}, ${p.dealId}, 'external',       ${p.amountKobo},  'payout', ${p.providerRef})
    on conflict do nothing
  `;
}

/**
 * Settle a payout when the partner confirms it (payout.settled webhook). Fail-loud:
 * refuses if the payout row is unknown, or the amount disagrees with the deal's
 * outstanding seller_payable. Marks the payout row settled + writes the ledger.
 */
export async function settlePayout(
  db: Sql,
  p: { dealId: string; amountKobo: number; providerRef: string },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const [po] = await sql<{ id: string; status: string; amount_kobo: string | number }[]>`
      select id, status, amount_kobo from public.payouts where deal_id = ${p.dealId} for update
    `;
    if (!po) return { ok: false, reason: "unknown_payout" };
    if (Number(po.amount_kobo) !== p.amountKobo)
      return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${po.amount_kobo}` };
    if (po.status === "settled") return { ok: true }; // idempotent
    const prior = await priorSettlement(sql, p.dealId, "payout", p.providerRef);
    if (prior === "different") return { ok: false, reason: "already_paid_diff_ref" };
    // Belt: the deal's outstanding seller_payable must equal what we're paying out.
    const [bal] = await sql<{ s: string }[]>`
      select coalesce(sum(amount_kobo), 0)::bigint as s from public.ledger_entries
      where deal_id = ${p.dealId} and account = 'seller_payable'
    `;
    if (Number(bal!.s) !== p.amountKobo)
      return { ok: false, reason: `balance_mismatch:${bal!.s}!=${p.amountKobo}` };

    await writePayout(sql, { dealId: p.dealId, amountKobo: p.amountKobo, providerRef: p.providerRef });
    await sql`
      update public.payouts set status = 'settled', settled_at = now(), provider_ref = ${p.providerRef}
      where deal_id = ${p.dealId} and status <> 'settled'
    `;
    return { ok: true };
  });
}

/** Reverse a hold back to the buyer (oversold / dispute / seller-cancel). Full make-whole. */
export async function writeRefund(
  sql: Tx,
  p: { dealId: string; seq: number | null; principal: number; fee: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, event_seq, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, ${p.seq}, 'escrow_holding', ${-p.principal},         'refund', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'wcp_fees',       ${-p.fee},               'refund', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'external',       ${p.principal + p.fee},  'refund', ${p.providerRef})
    on conflict do nothing
  `;
}

/**
 * Release held funds to the seller, net of the seller fee (M5). The payout is the
 * RESIDUAL (principal − sellerFee) so payout + fee equals the principal exactly — no
 * stray rounding kobo that the balance trigger would reject.
 */
export async function writeRelease(
  sql: Tx,
  p: { dealId: string; seq: number | null; principal: number; sellerFee: number; providerRef: string },
): Promise<void> {
  const grp = randomUUID();
  const payout = p.principal - p.sellerFee; // residual — payout + fee == principal
  await sql`
    insert into public.ledger_entries (txn_group, deal_id, event_seq, account, amount_kobo, movement, provider_ref)
    values
      (${grp}, ${p.dealId}, ${p.seq}, 'escrow_holding', ${-p.principal}, 'release', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'seller_payable', ${payout},       'release', ${p.providerRef}),
      (${grp}, ${p.dealId}, ${p.seq}, 'wcp_fees',       ${p.sellerFee},  'release', ${p.providerRef})
    on conflict do nothing
  `;
}

/**
 * Settle a release when the partner confirms it (release.settled webhook) — written
 * HERE, not at confirm time. Fail-loud: refuses (records, doesn't book) if the deal
 * is unknown, not COMPLETED (stops a double-spend before it happens rather than
 * detecting it 60s later in reconcile), or the settled amount disagrees with the
 * recomputed payout. Idempotent via writeRelease's ON CONFLICT on provider_ref.
 */
export async function settleRelease(
  db: Sql,
  p: { dealId: string; providerRef: string; amountKobo: number },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const [d] = await sql<{ state: string; price_kobo: string | number }[]>`
      select state, price_kobo from public.deals where id = ${p.dealId}
    `;
    if (!d) return { ok: false, reason: "unknown_deal" };
    if (d.state !== "COMPLETED") return { ok: false, reason: `not_completed:${d.state}` };
    const principal = Number(d.price_kobo);
    const sellerFee = sellerFeeKobo(principal);
    const expectedPayout = principal - sellerFee;
    if (p.amountKobo !== expectedPayout)
      return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${expectedPayout}` };
    const prior = await priorSettlement(sql, p.dealId, "release", p.providerRef);
    if (prior === "different") return { ok: false, reason: "already_released_diff_ref" };
    await writeRelease(sql, { dealId: p.dealId, seq: null, principal, sellerFee, providerRef: p.providerRef });
    return { ok: true };
  });
}

/**
 * Settle a refund when the partner confirms it (refund.settled webhook) — the
 * settlement ledger is written HERE, not optimistically at request time, so the
 * ledger only ever shows money that actually moved. Idempotent via writeRefund's
 * ON CONFLICT on provider_ref. The refunded amount = principal + buyer fee (the full
 * held amount); fee is derived from what was actually refunded.
 */
export async function settleRefund(
  db: Sql,
  p: { dealId: string; amountKobo: number; providerRef: string },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const [d] = await sql<{ state: string; price_kobo: string | number }[]>`
      select state, price_kobo from public.deals where id = ${p.dealId}
    `;
    if (!d) return { ok: false, reason: "unknown_deal" };
    if (d.state !== "REFUNDED") return { ok: false, reason: `not_refunded:${d.state}` };
    const principal = Number(d.price_kobo);
    // The refund must reverse exactly what the hold booked.
    const expected = (await heldAmount(sql, p.dealId)) ?? principal + buyerFeeKobo(principal);
    if (p.amountKobo !== expected)
      return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${expected}` };
    const prior = await priorSettlement(sql, p.dealId, "refund", p.providerRef);
    if (prior === "different") return { ok: false, reason: "already_refunded_diff_ref" };
    await writeRefund(sql, {
      dealId: p.dealId,
      seq: null,
      principal,
      fee: p.amountKobo - principal,
      providerRef: p.providerRef,
    });
    return { ok: true };
  });
}
