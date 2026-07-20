import type { DealRow, Tx } from "./commands.js";
import type { DealAction, DealState } from "./machine.js";
import { buyerFeeKobo, sellerFeeKobo } from "../money/fees.js";
import { writeHold } from "../money/ledger.js";

/**
 * Per-action side effects, run INSIDE the transition tx after the deal is locked and
 * the transition is known-legal, but BEFORE the deals UPDATE — so an effect can both
 * write DB side effects (ledger, stock) atomically with the state change AND redirect
 * the destination (return a different action). No external/provider calls here (that
 * would put a network call inside the tx); effects enqueue outbox commands instead,
 * which the escrow orchestrator consumes.
 *
 * Settlement rows (refund/release) are written on the SETTLEMENT webhook, not here,
 * so the ledger only ever reflects money that actually moved.
 */
export type EffectCtx = {
  deal: DealRow;
  to: DealState; // the pre-redirect target
  seq: number; // this event's seq — ledger/outbox rows key to it
  providerRef?: string; // the partner's real transaction ref (from the confirming webhook)
  confirmedAmountKobo?: number; // the amount the provider actually held
};
export type EffectResult = { redirectAction: DealAction } | void;
export type Effect = (sql: Tx, ctx: EffectCtx) => Promise<EffectResult>;

// Buyer confirms receipt, or the 48h timer auto-releases → release funds to the
// seller, net of the 2% seller fee. No ledger here — the release ledger is written
// on the release.settled webhook (symmetry with the hold).
const releaseFunds: Effect = async (sql, { deal, seq }) => {
  const principal = Number(deal.price_kobo);
  const sellerFee = sellerFeeKobo(principal);
  await sql`
    insert into public.outbox (topic, payload, deal_id, event_seq)
    values ('escrow.release',
      ${sql.json({ dealId: deal.id, seq, principal, sellerFee, payout: principal - sellerFee })},
      ${deal.id}, ${seq})
  `;
};

// Seller cancels, or the hand-off SLA lapses, on a paid-but-not-handed-off deal →
// refund the buyer the full held amount (make-whole). Refund ledger on refund.settled.
const refundBuyer: Effect = async (sql, { deal, seq }) => {
  const principal = Number(deal.price_kobo);
  const amount = principal + buyerFeeKobo(principal);
  await sql`
    insert into public.outbox (topic, payload, deal_id, event_seq)
    values ('escrow.refund',
      ${sql.json({ dealId: deal.id, seq, amount, reason: "cancelled" })},
      ${deal.id}, ${seq})
  `;
};

export const EFFECTS: Partial<Record<DealAction, Effect>> = {
  // Buyer initiates payment → ask the escrow orchestrator to create the hold. No
  // ledger yet (funds not captured until the provider confirms).
  pay: async (sql, { deal, seq }) => {
    const principal = Number(deal.price_kobo);
    const fee = buyerFeeKobo(principal);
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('escrow.create_hold',
        ${sql.json({ dealId: deal.id, seq, principal, fee, amount: principal + fee })},
        ${deal.id}, ${seq})
    `;
  },

  // Provider confirmed capture → record the hold using the provider's REAL ref and
  // held amount (so the ledger matches custody and can be reconciled), then decrement
  // stock. If stock is gone (oversold race), enqueue a refund and redirect to
  // REFUNDED; the refund ledger is written when refund.settled arrives (symmetry).
  payment_confirmed: async (sql, { deal, seq, providerRef, confirmedAmountKobo }) => {
    const principal = Number(deal.price_kobo);
    const amountHeld = confirmedAmountKobo ?? principal + buyerFeeKobo(principal);
    const fee = amountHeld - principal;
    await writeHold(sql, {
      dealId: deal.id,
      seq,
      principal,
      fee,
      providerRef: providerRef ?? `hold:${deal.id}`,
    });

    const dec = await sql`
      update public.listings set stock = stock - ${deal.qty}
      where id = ${deal.listing_id} and stock >= ${deal.qty}
      returning id
    `;
    if (dec.length === 0) {
      await sql`
        insert into public.outbox (topic, payload, deal_id, event_seq)
        values ('escrow.refund',
          ${sql.json({ dealId: deal.id, seq, amount: amountHeld, reason: "oversold" })},
          ${deal.id}, ${seq})
      `;
      return { redirectAction: "oversold" };
    }
  },

  // ── Fulfilment (M5) ─────────────────────────────────────────────────────────
  // hand_off moves state only (no money); no effect needed.
  confirm_receipt: releaseFunds,
  auto_release: releaseFunds,
  cancel_refund: refundBuyer,
  auto_refund: refundBuyer,
};
