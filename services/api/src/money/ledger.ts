import { randomUUID } from "node:crypto";
import type { Sql, Tx } from "../deals/commands.js";
import { buyerFeeKobo, sellerFeeKobo } from "./fees.js";
import { stageFeesOf, stagesOf } from "../deals/stages.js";

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
 * What refunding a STAGED job returns to the buyer: every stage still held, plus the
 * buyer fee only if no stage ever left escrow (nothing delivered → made whole, as on
 * an unstaged deal; once a stage is paid out the escrow service was used and WCP
 * keeps its fee). Null for an unstaged deal. One rule for the refund request and its
 * settlement, so the two can't disagree.
 */
export async function stageRefundKobo(sql: Tx, dealId: string): Promise<number | null> {
  const stages = await stagesOf(sql, dealId);
  if (!stages.length) return null;
  const heldKobo = stages.filter((s) => s.status === "held").reduce((a, s) => a + Number(s.amount_kobo), 0);
  if (stages.some((s) => s.status !== "held")) return heldKobo;
  const total = stages.reduce((a, s) => a + Number(s.amount_kobo), 0);
  const booked = await heldAmount(sql, dealId);
  return heldKobo + (booked != null ? booked - total : buyerFeeKobo(total));
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
  p: { dealId: string; amountKobo: number; providerRef: string; part?: number },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const part = p.part ?? 0;
    const [po] = await sql<{ id: string; status: string; amount_kobo: string | number }[]>`
      select id, status, amount_kobo from public.payouts where deal_id = ${p.dealId} and part = ${part} for update
    `;
    if (!po) return { ok: false, reason: "unknown_payout" };
    if (Number(po.amount_kobo) !== p.amountKobo)
      return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${po.amount_kobo}` };
    if (po.status === "settled") return { ok: true }; // idempotent
    // A staged job pays out in parts (one per request as stages release), so another
    // payout ref on the same deal is expected; the per-part row status is the guard.
    const staged = (await stagesOf(sql, p.dealId)).length > 0;
    if (!staged) {
      const prior = await priorSettlement(sql, p.dealId, "payout", p.providerRef);
      if (prior === "different") return { ok: false, reason: "already_paid_diff_ref" };
    }
    // Belt: never pay out more than the deal's outstanding seller_payable. Unstaged it
    // must be exactly that; staged, a later stage may have released meanwhile.
    const [bal] = await sql<{ s: string }[]>`
      select coalesce(sum(amount_kobo), 0)::bigint as s from public.ledger_entries
      where deal_id = ${p.dealId} and account = 'seller_payable'
    `;
    const short = staged ? Number(bal!.s) < p.amountKobo : Number(bal!.s) !== p.amountKobo;
    if (short) return { ok: false, reason: `balance_mismatch:${bal!.s}!=${p.amountKobo}` };

    await writePayout(sql, { dealId: p.dealId, amountKobo: p.amountKobo, providerRef: p.providerRef });
    await sql`
      update public.payouts set status = 'settled', settled_at = now(), provider_ref = ${p.providerRef}
      where deal_id = ${p.dealId} and part = ${part} and status <> 'settled'
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
    const staged = await stageRefundKobo(sql, p.dealId);
    if (staged != null) return settleStageRefund(sql, p, staged);
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

/** A staged job's refund settlement: the still-held stages (+ fee if none released). */
async function settleStageRefund(
  sql: Tx,
  p: { dealId: string; amountKobo: number; providerRef: string },
  expected: number,
): Promise<SettleResult> {
  if (p.amountKobo !== expected) return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${expected}` };
  const prior = await priorSettlement(sql, p.dealId, "refund", p.providerRef);
  if (prior === "different") return { ok: false, reason: "already_refunded_diff_ref" };
  if (prior === "same") return { ok: true };
  const stages = await stagesOf(sql, p.dealId, true);
  const principal = stages.filter((s) => s.status === "held").reduce((a, s) => a + Number(s.amount_kobo), 0);
  await writeRefund(sql, { dealId: p.dealId, seq: null, principal, fee: p.amountKobo - principal, providerRef: p.providerRef });
  await sql`update public.deal_milestones set status = 'refunded' where deal_id = ${p.dealId} and status = 'held'`;
  return { ok: true };
}

/**
 * Settle ONE stage's release (release.settled carrying part = stage idx). The gate is
 * the stage row, not the deal state: only a stage the confirm/auto-release/admin
 * effect moved to 'releasing' can settle, exactly once, for exactly its share
 * (amount − its slice of the seller fee). A redelivery with the same ref is a no-op;
 * a different ref for an already-released stage is refused (double-release).
 */
export async function settleStageRelease(
  db: Sql,
  p: { dealId: string; part: number; providerRef: string; amountKobo: number },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const stages = await stagesOf(sql, p.dealId, true);
    const st = stages.find((x) => x.idx === p.part);
    if (!st) return { ok: false, reason: "unknown_stage" };
    if (st.status === "released")
      return st.provider_ref === p.providerRef ? { ok: true } : { ok: false, reason: "already_released_diff_ref" };
    if (st.status !== "releasing") return { ok: false, reason: `stage_not_releasing:${st.status}` };
    const principal = Number(st.amount_kobo);
    const sellerFee = (await stageFeesOf(sql, p.dealId, stages))[st.idx - 1]!;
    if (p.amountKobo !== principal - sellerFee)
      return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${principal - sellerFee}` };
    await writeRelease(sql, { dealId: p.dealId, seq: st.release_seq, principal, sellerFee, providerRef: p.providerRef });
    await sql`
      update public.deal_milestones set status = 'released', provider_ref = ${p.providerRef}, released_at = now()
      where deal_id = ${p.dealId} and idx = ${p.part}
    `;
    return { ok: true };
  });
}

/**
 * Settle ONE stage's return to the buyer (refund.settled carrying part = stage idx) —
 * a shortlet's caution deposit going back while the booking itself stands. Gated on
 * the stage row like a stage release: only a stage the effect moved to 'refunding'
 * settles, once, for exactly its amount. No fee moves: the buyer fee was for the
 * escrow service, which the stay used.
 */
export async function settleStageReturn(
  db: Sql,
  p: { dealId: string; part: number; providerRef: string; amountKobo: number },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const stages = await stagesOf(sql, p.dealId, true);
    const st = stages.find((x) => x.idx === p.part);
    if (!st) return { ok: false, reason: "unknown_stage" };
    if (st.status === "refunded")
      return st.provider_ref === p.providerRef ? { ok: true } : { ok: false, reason: "already_refunded_diff_ref" };
    if (st.status !== "refunding") return { ok: false, reason: `stage_not_refunding:${st.status}` };
    const amount = Number(st.amount_kobo);
    if (p.amountKobo !== amount) return { ok: false, reason: `amount_mismatch:${p.amountKobo}!=${amount}` };
    await writeRefund(sql, { dealId: p.dealId, seq: st.release_seq, principal: amount, fee: 0, providerRef: p.providerRef });
    await sql`
      update public.deal_milestones set status = 'refunded', provider_ref = ${p.providerRef}, released_at = now()
      where deal_id = ${p.dealId} and idx = ${p.part}
    `;
    return { ok: true };
  });
}
