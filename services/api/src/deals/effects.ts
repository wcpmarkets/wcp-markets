import type { DealRow, Tx } from "./commands.js";
import type { DealAction, DealState } from "./machine.js";
import { buyerFeeKobo } from "../money/fees.js";
import { writeHold, writeRefund } from "../money/ledger.js";

/**
 * Per-action side effects, run INSIDE the transition tx after the deal is locked and
 * the transition is known-legal, but BEFORE the deals UPDATE — so an effect can both
 * write DB side effects (ledger, stock) atomically with the state change AND redirect
 * the destination (return a different action). No external/provider calls here (that
 * would put a network call inside the tx); effects enqueue outbox commands instead,
 * which the escrow orchestrator consumes.
 */
export type EffectCtx = {
  deal: DealRow;
  to: DealState; // the pre-redirect target
  seq: number; // this event's seq — ledger/outbox rows key to it
};
export type EffectResult = { redirectAction: DealAction } | void;
export type Effect = (sql: Tx, ctx: EffectCtx) => Promise<EffectResult>;

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

  // Provider confirmed capture → record the hold, then decrement stock. If stock is
  // gone (oversold race — two buyers paid for the last unit), reverse the hold, tell
  // the orchestrator to refund, and redirect this deal to REFUNDED instead of
  // PAID_IN_ESCROW. All atomic in this tx.
  payment_confirmed: async (sql, { deal, seq }) => {
    const principal = Number(deal.price_kobo);
    const fee = buyerFeeKobo(principal);
    await writeHold(sql, { dealId: deal.id, seq, principal, fee, providerRef: `hold:${deal.id}` });

    const dec = await sql`
      update public.listings set stock = stock - ${deal.qty}
      where id = ${deal.listing_id} and stock >= ${deal.qty}
      returning id
    `;
    if (dec.length === 0) {
      await writeRefund(sql, { dealId: deal.id, seq, principal, fee, providerRef: `refund:oversold:${deal.id}` });
      await sql`
        insert into public.outbox (topic, payload, deal_id, event_seq)
        values ('escrow.refund',
          ${sql.json({ dealId: deal.id, seq, amount: principal + fee, reason: "oversold" })},
          ${deal.id}, ${seq})
      `;
      return { redirectAction: "oversold" };
    }
  },
};
