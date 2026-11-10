import type { DealRow, Tx } from "./commands.js";
import type { DealAction, DealState } from "./machine.js";
import { buyerFeeKobo, sellerFeeKobo, stageSellerFees } from "../money/fees.js";
import { stageRefundKobo, writeHold } from "../money/ledger.js";
import { stagesOf } from "./stages.js";

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
  action: DealAction; // the requested action (for the refund/release reason)
  providerRef?: string; // the partner's real transaction ref (from the confirming webhook)
  confirmedAmountKobo?: number; // the amount the provider actually held
};
export type EffectResult = { redirectAction: DealAction } | void;
export type Effect = (sql: Tx, ctx: EffectCtx) => Promise<EffectResult>;

function refundReason(action: DealAction, fromState: DealState): string {
  switch (action) {
    case "cancel_refund":
      return "seller_cancel";
    case "resolve_refund":
      return "admin_refund";
    case "auto_refund":
      return fromState === "DISPUTED" ? "dispute_timeout" : "sla_lapse";
    default:
      return "refund";
  }
}

// Buyer confirms receipt, the 48h timer auto-releases, or an admin resolves for the
// seller → release funds net of the 2% seller fee. No ledger here — the release
// ledger is written on the release.settled webhook (symmetry with the hold).
const releaseFunds: Effect = async (sql, { deal, seq, action }) => {
  const stages = await stagesOf(sql, deal.id, true);
  if (stages.length) return releaseStages(sql, deal, seq, action, stages);
  const principal = Number(deal.price_kobo);
  const sellerFee = sellerFeeKobo(principal);
  const reason =
    action === "resolve_release" ? "admin_release" : action === "auto_release" ? "auto_release" : "confirmed";
  await sql`
    insert into public.outbox (topic, payload, deal_id, event_seq)
    values ('escrow.release',
      ${sql.json({ dealId: deal.id, seq, principal, sellerFee, payout: principal - sellerFee, reason })},
      ${deal.id}, ${seq})
  `;
};

// A staged job releases one stage at a time: the buyer's confirm (or the 48h timer)
// releases the CURRENT stage — the first still held — and, while later stages remain
// held, redirects to release_stage so the deal goes back to PAID_IN_ESCROW for the
// next one. An admin resolving a dispute for the provider releases everything held.
// Each stage is its own escrow command (part = stage idx) and settles on its own.
const releaseStages = async (
  sql: Tx,
  deal: DealRow,
  seq: number,
  action: DealAction,
  stages: Awaited<ReturnType<typeof stagesOf>>,
): Promise<EffectResult> => {
  const fees = stageSellerFees(stages.map((s) => Number(s.amount_kobo)));
  const held = stages.filter((s) => s.status === "held");
  const all = action === "resolve_release";
  const now = all ? held : held.slice(0, 1);
  const reason = all ? "admin_release" : action === "auto_release" ? "auto_release" : "confirmed";
  for (const st of now) {
    const principal = Number(st.amount_kobo);
    const sellerFee = fees[st.idx - 1]!;
    await sql`
      update public.deal_milestones set status = 'releasing', release_seq = ${seq}
      where deal_id = ${deal.id} and idx = ${st.idx} and status = 'held'
    `;
    await sql`
      insert into public.outbox (topic, payload, deal_id, event_seq)
      values ('escrow.release',
        ${sql.json({ dealId: deal.id, seq, part: st.idx, principal, sellerFee, payout: principal - sellerFee, reason })},
        ${deal.id}, ${seq})
    `;
  }
  if (!all && held.length > now.length) return { redirectAction: "release_stage" };
};

// Seller cancels, the hand-off SLA lapses, a dispute times out, or an admin resolves
// for the buyer → refund the buyer. Refund exactly what the hold booked (from the
// ledger — the fee config may have changed since the hold), NOT a recomputation.
// Refund ledger is written on the refund.settled webhook.
const refundBuyer: Effect = async (sql, { deal, seq, action }) => {
  const [held] = await sql<{ amount: string | null }[]>`
    select (-sum(amount_kobo))::bigint as amount
    from public.ledger_entries
    where deal_id = ${deal.id} and movement = 'hold' and account = 'external'
  `;
  const principal = Number(deal.price_kobo);
  // A staged job refunds only what is still held (stages.ts) — released stages are
  // the provider's. stageRefundKobo is the same rule the refund settlement checks.
  const staged = await stageRefundKobo(sql, deal.id);
  const amount = staged ?? (held?.amount != null ? Number(held.amount) : principal + buyerFeeKobo(principal));
  await sql`
    insert into public.outbox (topic, payload, deal_id, event_seq)
    values ('escrow.refund',
      ${sql.json({ dealId: deal.id, seq, amount, reason: refundReason(action, deal.state) })},
      ${deal.id}, ${seq})
  `;
  // A 24h-silence auto-refund resolves a dispute with NO route running — close the
  // support case row here, in-tx, so it can't rot at status='open' in the queue.
  if (action === "auto_refund" && deal.state === "DISPUTED") {
    await sql`
      update public.dispute_cases
      set status = 'resolved', resolution = 'refund', resolved_at = now(),
          resolution_note = coalesce(resolution_note, 'auto-refund: seller did not respond in 24h')
      where deal_id = ${deal.id} and status <> 'resolved'
    `;
  }
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

    // A staged quote: the plan the buyer accepted becomes the stages escrow releases
    // against. The DB checks they sum to the price (deal_milestones_sum, deferred).
    const plan = deal.terms?.milestones;
    if (plan?.length) {
      for (const [i, st] of plan.entries()) {
        await sql`
          insert into public.deal_milestones (deal_id, idx, title, amount_kobo)
          values (${deal.id}, ${i + 1}, ${st.title}, ${st.amountKobo})
          on conflict (deal_id, idx) do nothing
        `;
      }
    }

    // A service is a provider's time, not a unit on a shelf: a booked job never
    // sells out the listing, so only goods-style lanes decrement stock.
    const dec = await sql`
      update public.listings set stock = stock - ${deal.qty}
      where id = ${deal.listing_id} and stock >= ${deal.qty} and lane <> 'services'
      returning id
    `;
    const [svc] = dec.length === 0
      ? await sql`select 1 from public.listings where id = ${deal.listing_id} and lane = 'services'`
      : [];
    if (svc) return;
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

  // ── Dispute resolutions (M6) — wired now so an admin resolution can never move a
  // funded deal to a terminal state without enqueuing the corresponding escrow
  // command (unreachable until the dispute route exists, so this is inert today).
  resolve_release: releaseFunds,
  resolve_refund: refundBuyer,
};
