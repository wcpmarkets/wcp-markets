import { randomBytes } from "node:crypto";
import type { Sql } from "../deals/commands.js";
import { settlePayout, settleRefund, settleStageReturn } from "./ledger.js";
import { applyPaystackCharge } from "./checkout.js";
import { createRefund, initiateTransfer, PaystackError, type PaystackTxn } from "./paystack.js";

/**
 * Paystack's side of the money spine (Phase 3 H):
 *   • the consumer turns escrow COMMANDS for Paystack deals into Paystack calls
 *     (refund, transfer) and records what it asked for;
 *   • the webhook turns Paystack's signed EVENTS into the same settlements the mock
 *     drives (settleRefund / settleStageReturn / settlePayout), so the ledger can't
 *     tell the rails apart.
 * Releases never touch Paystack: the money is already in WCP's balance, so a release
 * is a ledger move (the consumer settles it itself, as with the mock).
 */

export async function dealRail(db: Sql, dealId: string): Promise<"mock" | "paystack"> {
  const [d] = await db<{ payment_provider: string | null }[]>`select payment_provider from public.deals where id = ${dealId}`;
  return d?.payment_provider === "paystack" ? "paystack" : "mock";
}

/** The successful charge a deal was paid with (refunds go against it). */
async function paidReference(db: Sql, dealId: string): Promise<string | null> {
  const [p] = await db<{ reference: string }[]>`
    select reference from public.payments where deal_id = ${dealId} and status = 'success' order by paid_at desc limit 1`;
  return p?.reference ?? null;
}

/** escrow.refund on a Paystack deal → a Paystack refund (settled by refund.processed). */
export async function requestRefund(db: Sql, p: { dealId: string; amountKobo: number; part?: number }): Promise<void> {
  const key = `refund:${p.dealId}${p.part ? `:${p.part}` : ""}`;
  const [row] = await db<{ id: string; paystack_refund_id: string | null; status: string }[]>`
    insert into public.payment_refunds (deal_id, part, amount_kobo, idempotency_key)
    values (${p.dealId}, ${p.part ?? null}, ${p.amountKobo}, ${key})
    on conflict (idempotency_key) do update set updated_at = now()
    returning id, paystack_refund_id, status`;
  if (row!.paystack_refund_id || row!.status !== "pending") return; // already asked (redelivery)
  const reference = await paidReference(db, p.dealId);
  if (!reference) throw new Error(`[refund] ${p.dealId}: no successful Paystack charge to refund`);
  try {
    const r = await createRefund({ reference, amountKobo: p.amountKobo, note: `WCP escrow refund ${key}` });
    await db`update public.payment_refunds set paystack_refund_id = ${String(r.id)}, updated_at = now() where id = ${row!.id}`;
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    // Paystack said no (4xx: over-refund, balance, …): retrying won't change that —
    // mark it failed and land it for support. Anything else (network, 5xx) SQS retries.
    if (e instanceof PaystackError && e.status >= 400 && e.status < 500) {
      await db`update public.payment_refunds set status = 'failed', error = ${msg}, updated_at = now() where id = ${row!.id}`;
      return exception(db, p.dealId, "escrow.refund", "refund_rejected", { amount: p.amountKobo, part: p.part ?? null, message: msg });
    }
    await db`update public.payment_refunds set error = ${msg}, updated_at = now() where id = ${row!.id}`;
    throw e;
  }
}

/** A charge that arrived for a deal that can't take it: return all of it. No ledger — it was never booked. */
export async function refundLatePayment(db: Sql, p: { dealId: string; reference: string; amountKobo: number }): Promise<void> {
  const key = `late:${p.reference}`;
  const [row] = await db<{ id: string; paystack_refund_id: string | null }[]>`
    insert into public.payment_refunds (deal_id, amount_kobo, idempotency_key)
    values (${p.dealId}, ${p.amountKobo}, ${key})
    on conflict (idempotency_key) do update set updated_at = now()
    returning id, paystack_refund_id`;
  if (row!.paystack_refund_id) return;
  const r = await createRefund({ reference: p.reference, amountKobo: p.amountKobo, note: "Payment arrived after the checkout closed" });
  await db`update public.payment_refunds set paystack_refund_id = ${String(r.id)}, updated_at = now() where id = ${row!.id}`;
}

/** escrow.payout on a Paystack deal → a Transfer to the seller's saved account. */
export async function requestTransfer(db: Sql, p: { dealId: string; amountKobo: number; sellerId: string; part?: number }): Promise<void> {
  const [acct] = await db<{ recipient_code: string; provider: string }[]>`
    select recipient_code, provider from public.payout_accounts where user_id = ${p.sellerId}`;
  if (!acct || acct.provider !== "paystack") throw new Error(`[payout] ${p.dealId}: seller has no Paystack payout account`);
  const [po] = await db<{ id: string; transfer_reference: string | null; status: string }[]>`
    select id, transfer_reference, status from public.payouts where deal_id = ${p.dealId} and part = ${p.part ?? 0}`;
  if (!po || po.status !== "pending") return;
  // Paystack transfer references: lowercase alphanumerics, '-', '_', 16–50 chars. Saved
  // before the call, so an SQS retry reuses it and Paystack refuses a duplicate rather
  // than paying twice. A payout retried after a failure gets a new one (the route clears it).
  const reference = po.transfer_reference ?? `wcp-po-${p.dealId.replace(/-/g, "")}-${p.part ?? 0}-${randomBytes(3).toString("hex")}`;
  if (!po.transfer_reference) await db`update public.payouts set transfer_reference = ${reference} where id = ${po.id}`;
  try {
    await initiateTransfer({ amountKobo: p.amountKobo, recipientCode: acct.recipient_code, reference, reason: "WCP Markets escrow payout" });
  } catch (e) {
    // Duplicate reference = the first attempt went through; its webhook will settle it.
    if (e instanceof PaystackError && /duplicate|already/i.test(e.message)) return;
    // Refused (4xx: balance, recipient, …): the seller can request it again once fixed.
    if (e instanceof PaystackError && e.status >= 400 && e.status < 500) {
      await db`update public.payouts set status = 'failed' where id = ${po.id} and status = 'pending'`;
      return exception(db, p.dealId, "escrow.payout", "transfer_rejected", { reference, amount: p.amountKobo, message: e.message.slice(0, 300) });
    }
    throw e;
  }
}

async function exception(db: Sql, dealId: string | null, kind: string, detail: string, payload: unknown) {
  await db`
    insert into public.reconciliation_exceptions (deal_id, kind, detail, payload)
    values (${dealId}, ${kind}, ${detail}, ${db.json(payload as never)})`;
  console.warn(`[paystack] ${kind} ${dealId ?? "-"} → ${detail} (recorded)`);
}

type Event = { event: string; data: Record<string, unknown> };

/** Apply one verified Paystack webhook event. Never throws on bad data — records it. */
export async function handlePaystackEvent(db: Sql, ev: Event): Promise<void> {
  const d = ev.data;
  switch (ev.event) {
    case "charge.success": {
      const tx = d as unknown as PaystackTxn;
      const out = await applyPaystackCharge(db, tx);
      const [p] = await db<{ deal_id: string }[]>`select deal_id from public.payments where reference = ${tx.reference}`;
      if (out === "refund_late") {
        await db`
          insert into public.outbox (topic, payload, deal_id)
          values ('paystack.refund_late', ${db.json({ dealId: p!.deal_id, reference: tx.reference, amount: tx.amount })}, ${p!.deal_id})`;
        await exception(db, p!.deal_id, "charge.success", "late_payment_refunding", { reference: tx.reference, amount: tx.amount });
      } else if (out === "mismatch" || out === "unknown") {
        await exception(db, p?.deal_id ?? null, "charge.success", out, { reference: tx.reference, amount: tx.amount, currency: tx.currency });
      }
      return;
    }
    case "refund.processed":
    case "refund.failed": {
      const refundId = d.id != null ? String(d.id) : null;
      const txRef = (d.transaction_reference as string | undefined) ?? null;
      const amount = Number(d.amount);
      let [r] = refundId
        ? await db<{ id: string; deal_id: string; part: number | null; amount_kobo: string; status: string; idempotency_key: string }[]>`
            select id, deal_id, part, amount_kobo, status, idempotency_key from public.payment_refunds where paystack_refund_id = ${refundId}`
        : [];
      if (!r && txRef) {
        // Fallback: the oldest pending refund of that amount against that charge.
        [r] = await db`
          select fr.id, fr.deal_id, fr.part, fr.amount_kobo, fr.status, fr.idempotency_key from public.payment_refunds fr
          join public.payments p on p.deal_id = fr.deal_id and p.reference = ${txRef}
          where fr.status = 'pending' and fr.amount_kobo = ${amount} order by fr.created_at limit 1`;
      }
      if (!r) return exception(db, null, ev.event, "unknown_refund", { refundId, txRef, amount });
      if (ev.event === "refund.failed") {
        await db`update public.payment_refunds set status = 'failed', error = 'paystack: refund.failed', updated_at = now() where id = ${r.id}`;
        return exception(db, r.deal_id, ev.event, "refund_failed", { refundId, amount });
      }
      if (r.status === "processed") return; // redelivery
      await db`update public.payment_refunds set status = 'processed', updated_at = now() where id = ${r.id}`;
      if (r.idempotency_key.startsWith("late:")) return; // never booked — nothing to settle
      const providerRef = `paystack-refund:${refundId ?? r.id}`;
      const res = r.part
        ? await settleStageReturn(db, { dealId: r.deal_id, part: r.part, providerRef, amountKobo: Number(r.amount_kobo) })
        : await settleRefund(db, { dealId: r.deal_id, amountKobo: Number(r.amount_kobo), providerRef });
      if (!res.ok) await exception(db, r.deal_id, ev.event, `settle:${res.reason}`, { refundId, amount });
      return;
    }
    case "transfer.success":
    case "transfer.failed":
    case "transfer.reversed": {
      const reference = d.reference as string;
      const [po] = await db<{ deal_id: string; part: number; amount_kobo: string; status: string }[]>`
        select deal_id, part, amount_kobo, status from public.payouts where transfer_reference = ${reference}`;
      if (!po) return exception(db, null, ev.event, "unknown_transfer", { reference });
      if (ev.event === "transfer.success") {
        const res = await settlePayout(db, {
          dealId: po.deal_id,
          amountKobo: Number(d.amount),
          providerRef: String(d.transfer_code ?? reference),
          part: po.part || undefined,
        });
        if (!res.ok) await exception(db, po.deal_id, ev.event, `settle:${res.reason}`, { reference, amount: d.amount });
      } else {
        // The money is back in (or never left) WCP's balance; seller_payable still
        // owes it. Mark it so support can retry once the account is fixed.
        await db`update public.payouts set status = 'failed' where transfer_reference = ${reference} and status = 'pending'`;
        await exception(db, po.deal_id, ev.event, "transfer_not_completed", { reference, reason: d.reason ?? null });
      }
      return;
    }
    default:
      return; // other events (customer, subscription, …) don't concern escrow
  }
}
