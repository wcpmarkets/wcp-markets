import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchSsm } from "../secrets.js";

/**
 * Paystack REST client — the few endpoints escrow needs. Amounts are kobo, as Paystack
 * expects for NGN. The secret key comes from PAYSTACK_SECRET_KEY (local) or SSM
 * PAYSTACK_SECRET_KEY_SSM (default /wcp/api/paystack-secret-key); without one,
 * Paystack is "unconfigured" and every deal stays on the mock rail.
 *
 * Never log a request body or the key; errors carry Paystack's message only.
 */
const BASE = (process.env.PAYSTACK_BASE_URL ?? "https://api.paystack.co").replace(/\/$/, "");

let key: Promise<string | undefined> | null = null;
export function paystackKey(): Promise<string | undefined> {
  key ??= (async () =>
    process.env.PAYSTACK_SECRET_KEY ??
    (await fetchSsm(process.env.PAYSTACK_SECRET_KEY_SSM ?? "/wcp/api/paystack-secret-key")))();
  return key;
}
export async function paystackConfigured(): Promise<boolean> {
  return !!(await paystackKey());
}
/** sk_test_… → test mode (checkout takes test cards; transfers are simulated). */
export async function paystackTestMode(): Promise<boolean> {
  return (await paystackKey())?.startsWith("sk_test_") ?? false;
}

export class PaystackError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const k = await paystackKey();
  if (!k) throw new PaystackError(503, "paystack_unconfigured");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T; code?: string };
  if (!res.ok || j.status === false) throw new PaystackError(res.status, j.message ?? `HTTP ${res.status}`, j.code);
  return j.data as T;
}

// ── Collections ───────────────────────────────────────────────────────────────
export type InitResult = { authorization_url: string; access_code: string; reference: string };
export function initializeTransaction(p: {
  email: string;
  amountKobo: number;
  reference: string;
  callbackUrl: string;
  metadata: Record<string, unknown>;
}): Promise<InitResult> {
  return call<InitResult>("POST", "/transaction/initialize", {
    email: p.email,
    amount: p.amountKobo,
    currency: "NGN",
    reference: p.reference,
    callback_url: p.callbackUrl,
    metadata: p.metadata,
    channels: ["card", "bank_transfer", "ussd", "bank"],
  });
}

export type PaystackTxn = {
  id: number;
  reference: string;
  status: "success" | "failed" | "abandoned" | "ongoing" | "pending" | "processing" | "queued" | "reversed";
  amount: number;
  currency: string;
  fees: number | null;
  channel: string | null;
  paid_at: string | null;
  metadata?: Record<string, unknown> | string | null;
};
export function verifyTransaction(reference: string): Promise<PaystackTxn> {
  return call<PaystackTxn>("GET", `/transaction/verify/${encodeURIComponent(reference)}`);
}

// ── Refunds ───────────────────────────────────────────────────────────────────
export type PaystackRefund = { id: number; amount: number; status: string; transaction: { reference?: string } | number };
export function createRefund(p: { reference: string; amountKobo: number; note: string }): Promise<PaystackRefund> {
  return call<PaystackRefund>("POST", "/refund", { transaction: p.reference, amount: p.amountKobo, merchant_note: p.note });
}

// ── Payouts (Transfers) ───────────────────────────────────────────────────────
export type Bank = { name: string; code: string; slug: string; active: boolean; type: string };
let banksCache: { at: number; banks: Bank[] } | null = null;
/** Nigerian banks that can receive transfers (cached 12h per warm Lambda). */
export async function listBanks(): Promise<Bank[]> {
  if (banksCache && Date.now() - banksCache.at < 12 * 3_600_000) return banksCache.banks;
  const banks = await call<Bank[]>("GET", "/bank?country=nigeria&currency=NGN&perPage=200");
  banksCache = { at: Date.now(), banks: banks.filter((b) => b.active && b.type === "nuban") };
  return banksCache.banks;
}
export function resolveAccount(accountNumber: string, bankCode: string): Promise<{ account_number: string; account_name: string }> {
  return call("GET", `/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
}
export function createRecipient(p: { name: string; accountNumber: string; bankCode: string; userId: string }): Promise<{ recipient_code: string }> {
  return call("POST", "/transferrecipient", {
    type: "nuban",
    name: p.name,
    account_number: p.accountNumber,
    bank_code: p.bankCode,
    currency: "NGN",
    metadata: { userId: p.userId },
  });
}
export type PaystackTransfer = { transfer_code: string; reference: string; status: string; amount: number };
export function initiateTransfer(p: { amountKobo: number; recipientCode: string; reference: string; reason: string }): Promise<PaystackTransfer> {
  return call<PaystackTransfer>("POST", "/transfer", {
    source: "balance",
    amount: p.amountKobo,
    recipient: p.recipientCode,
    reference: p.reference,
    reason: p.reason,
  });
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
/** Paystack signs the raw body: HMAC-SHA512 with the secret key, hex, in x-paystack-signature. */
export async function verifyPaystackSignature(raw: string, signature: string | undefined): Promise<boolean> {
  const k = await paystackKey();
  if (!k || !signature) return false;
  const expected = createHmac("sha512", k).update(raw).digest("hex");
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}
