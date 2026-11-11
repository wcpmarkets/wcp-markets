import { randomBytes } from "node:crypto";
import type { Sql } from "../deals/commands.js";
import { transition } from "../deals/commands.js";
import { buyerFeeKobo, processingFeeKobo } from "./fees.js";
import { initializeTransaction, paystackConfigured, PaystackError, verifyTransaction, type PaystackTxn } from "./paystack.js";

/**
 * Checkout on Paystack (Phase 3 H). The buyer's "pay" moves the deal to
 * PAYMENT_PENDING and opens a Paystack checkout; the money is confirmed only by
 * Paystack — its signed charge.success webhook, or the sweeper verifying a checkout
 * left open — never by the app.
 *
 *   charge = principal + WCP buyer fee (net, what escrow holds) + processing fee
 *   (the buyer covers Paystack's cut, so exactly `net` lands in custody)
 *
 * Rail per deal (deals.payment_provider, set at pay): Paystack when configured,
 * except automated test accounts (clitest+…@wcp-test.local), which stay on the
 * mock so the end-to-end suites can run without a human at a checkout page.
 */
export type Rail = "mock" | "paystack";
export const CHECKOUT_TTL_MIN = 30;

export async function isTestAccount(db: Sql, userId: string): Promise<boolean> {
  const [u] = await db<{ email: string | null }[]>`select email from auth.users where id = ${userId}`;
  // clitest+ps-… accounts are the Paystack suite's own (test-cloud-paystack): they take
  // the real rail, against Paystack's test mode.
  return !!u?.email && /^clitest\+(?!ps-).*@wcp-test\.local$/i.test(u.email);
}

export async function railFor(db: Sql, buyerId: string): Promise<Rail> {
  if (!(await paystackConfigured())) return "mock";
  return (await isTestAccount(db, buyerId)) ? "mock" : "paystack";
}

export type PaymentQuote = { rail: Rail; principalKobo: number; buyerFeeKobo: number; processingFeeKobo: number; totalKobo: number };
export function quote(rail: Rail, principal: number): PaymentQuote {
  const fee = buyerFeeKobo(principal);
  const processing = rail === "paystack" ? processingFeeKobo(principal + fee) : 0;
  return { rail, principalKobo: principal, buyerFeeKobo: fee, processingFeeKobo: processing, totalKobo: principal + fee + processing };
}

export type Checkout = { reference: string; authorizationUrl: string; accessCode: string; totalKobo: number; processingFeeKobo: number; expiresAt: string };
type PaymentRow = {
  id: string; deal_id: string; reference: string; net_kobo: string | number; processing_fee_kobo: string | number;
  gross_kobo: string | number; status: string; access_code: string | null; authorization_url: string | null; created_at: Date;
};
const toCheckout = (p: PaymentRow): Checkout => ({
  reference: p.reference,
  authorizationUrl: p.authorization_url!,
  accessCode: p.access_code!,
  totalKobo: Number(p.gross_kobo),
  processingFeeKobo: Number(p.processing_fee_kobo),
  expiresAt: new Date(p.created_at.getTime() + CHECKOUT_TTL_MIN * 60_000).toISOString(),
});

/** Where Paystack sends the browser after paying; the app's WebView watches for it. */
export function callbackUrl(): string {
  const base = (process.env.PUBLIC_API_URL ?? "").replace(/\/$/, "");
  return `${base}/payments/paystack/return`;
}

/**
 * Paystack needs an email; phone-only accounts get a stable stand-in on our own domain
 * (Paystack rejects reserved TLDs like .invalid). Receipts to it bounce unless a
 * catch-all for customers.wcpmarkets.com is set up.
 */
async function customerEmail(db: Sql, userId: string): Promise<string> {
  const [u] = await db<{ email: string | null }[]>`select nullif(email, '') as email from auth.users where id = ${userId}`;
  // Reserved TLDs (e.g. the clitest+ps-…@wcp-test.local accounts) fail Paystack's check.
  if (u?.email && !/\.(local|invalid|test|example|localhost)$/i.test(u.email)) return u.email;
  const domain = process.env.PAYSTACK_CUSTOMER_EMAIL_DOMAIN ?? "customers.wcpmarkets.com";
  return `u${userId.replace(/-/g, "")}@${domain}`;
}

/**
 * The open checkout for a PAYMENT_PENDING Paystack deal: the existing one while it's
 * fresh, else a new one (new reference — Paystack references are single-use).
 */
export async function openCheckout(db: Sql, dealId: string, buyerId: string): Promise<Checkout> {
  const [d] = await db<{ price_kobo: string | number; state: string }[]>`select price_kobo, state from public.deals where id = ${dealId}`;
  if (!d || d.state !== "PAYMENT_PENDING") throw new PaystackError(409, "not_payment_pending");
  const [open] = await db<PaymentRow[]>`
    select * from public.payments
    where deal_id = ${dealId} and status = 'initialized' and authorization_url is not null
      and created_at > now() - make_interval(mins => ${CHECKOUT_TTL_MIN - 5})
    order by created_at desc limit 1`;
  if (open) return toCheckout(open);

  const q = quote("paystack", Number(d.price_kobo));
  const net = q.principalKobo + q.buyerFeeKobo;
  // Paystack references: alphanumerics, '-', '.', '='.
  const reference = `wcp-${dealId.slice(0, 8)}-${randomBytes(6).toString("hex")}`;
  const [row] = await db<PaymentRow[]>`
    insert into public.payments (deal_id, reference, net_kobo, processing_fee_kobo, gross_kobo)
    values (${dealId}, ${reference}, ${net}, ${q.processingFeeKobo}, ${q.totalKobo})
    returning *`;
  try {
    const init = await initializeTransaction({
      email: await customerEmail(db, buyerId),
      amountKobo: q.totalKobo,
      reference,
      callbackUrl: callbackUrl(),
      metadata: { dealId, buyerId, netKobo: net, processingFeeKobo: q.processingFeeKobo },
    });
    const [upd] = await db<PaymentRow[]>`
      update public.payments set access_code = ${init.access_code}, authorization_url = ${init.authorization_url}, updated_at = now()
      where id = ${row!.id} returning *`;
    return toCheckout(upd!);
  } catch (e) {
    await db`update public.payments set status = 'failed', updated_at = now() where id = ${row!.id}`;
    throw e;
  }
}

export type ApplyOutcome = "confirmed" | "replay" | "late_confirmed" | "mismatch" | "unknown" | "refund_late" | "not_success";

/**
 * Apply a Paystack transaction we've been told about (webhook) or looked up
 * (sweeper). Idempotent: the transition is keyed on the reference. The amount must be
 * exactly what we asked for, in NGN — anything else is refused and recorded.
 *
 * A payment that arrives after we gave up on the checkout (deal back in ACCEPTED,
 * still unpaid) is taken: the deal moves to PAYMENT_PENDING and is confirmed. If the
 * deal has moved on otherwise (paid another way, cancelled), the money is refunded.
 */
export async function applyPaystackCharge(db: Sql, tx: PaystackTxn): Promise<ApplyOutcome> {
  const [p] = await db<PaymentRow[]>`select * from public.payments where reference = ${tx.reference}`;
  if (!p) return "unknown";
  if (tx.status !== "success") return "not_success";
  if (tx.currency !== "NGN" || tx.amount !== Number(p.gross_kobo)) return "mismatch";
  const net = Number(p.net_kobo);
  const markPaid = () => db`
    update public.payments set status = 'success', psp_fee_kobo = ${tx.fees ?? null}, channel = ${tx.channel ?? null},
      paid_at = ${tx.paid_at ? new Date(tx.paid_at) : new Date()}, updated_at = now()
    where id = ${p.id}`;

  const confirm = () => transition(db, {
    dealId: p.deal_id,
    actor: "SYSTEM",
    action: "payment_confirmed",
    idempotencyKey: `paystack:${tx.reference}`,
    providerRef: tx.reference,
    confirmedAmountKobo: net,
  });
  let r = await confirm();
  if (r.ok) { await markPaid(); return r.replay ? "replay" : "confirmed"; }
  if (r.code === "idempotency_reuse") { await markPaid(); return "replay"; }

  // Late: the checkout was given up on, but nothing else happened to the deal.
  const [d] = await db<{ state: string; buyer_id: string }[]>`select state, buyer_id from public.deals where id = ${p.deal_id}`;
  if (d?.state === "ACCEPTED") {
    const re = await transition(db, { dealId: p.deal_id, actor: "BUYER", actorId: d.buyer_id, action: "pay", idempotencyKey: `paystack-late:${tx.reference}` });
    if (re.ok) {
      r = await confirm();
      if (r.ok) { await markPaid(); return "late_confirmed"; }
    }
  }
  // Paid for a deal that can't take it any more: give it back (see refundLatePayment).
  await db`update public.payments set status = 'refunded_late', psp_fee_kobo = ${tx.fees ?? null}, updated_at = now() where id = ${p.id}`;
  return "refund_late";
}

/** Sweeper: checkouts left open past their TTL — ask Paystack, then confirm or give up. */
export async function expireStaleCheckouts(db: Sql): Promise<{ confirmed: number; abandoned: number }> {
  let confirmed = 0;
  let abandoned = 0;
  const stale = await db<PaymentRow[]>`
    select * from public.payments
    where status = 'initialized' and created_at < now() - make_interval(mins => ${CHECKOUT_TTL_MIN})
    order by created_at limit 20`;
  for (const p of stale) {
    let tx: PaystackTxn | null = null;
    try { tx = await verifyTransaction(p.reference); } catch (e) {
      // Never initialized at Paystack (or unknown there): nothing was paid.
      if (!(e instanceof PaystackError && (e.status === 400 || e.status === 404))) throw e;
    }
    if (tx?.status === "success") {
      const out = await applyPaystackCharge(db, tx);
      if (out === "confirmed" || out === "late_confirmed" || out === "replay") confirmed++;
      continue;
    }
    if (tx && ["ongoing", "pending", "processing", "queued"].includes(tx.status)) continue; // still moving — next tick
    await db`update public.payments set status = 'abandoned', updated_at = now() where id = ${p.id}`;
    // No other checkout open for this deal → put it back to ACCEPTED so the buyer can retry.
    const [other] = await db`select 1 from public.payments where deal_id = ${p.deal_id} and status = 'initialized' limit 1`;
    if (!other) {
      await transition(db, { dealId: p.deal_id, actor: "SYSTEM", action: "payment_failed", idempotencyKey: `paystack-abandoned:${p.reference}` });
    }
    abandoned++;
  }
  return { confirmed, abandoned };
}
