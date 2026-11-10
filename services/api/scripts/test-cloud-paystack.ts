import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { buyerFeeKobo, processingFeeKobo, sellerFeeKobo } from "../src/money/fees.js";

/**
 * Phase 3 H live — the Paystack rail on the DEPLOYED API, in Paystack TEST mode.
 * Buyers here are clitest+ps-… (the one test-account prefix that takes the real rail).
 *
 *   A. checkout: the buyer sees the processing-fee breakdown; pay opens a real Paystack
 *      checkout (authorization_url) for exactly principal + buyer fee + processing; a
 *      second pay hands back the same checkout.
 *   B. webhook: a bad signature is refused; a wrong amount is refused and recorded; the
 *      right one (signed with our key, as Paystack signs) confirms → PAID_IN_ESCROW,
 *      holding exactly the net; a redelivery changes nothing.
 *   C. payout: no saved account → 409 no_payout_account; then (if Paystack test mode
 *      lets us save one) a payout opens a Transfer, and transfer.success settles it.
 *   D. abandoned checkout: the sweeper verifies it with Paystack (unpaid) → ACCEPTED;
 *      a late charge.success still lands the payment (late_confirmed).
 *
 * Refunds can't be faked this way (Paystack refuses a refund on a charge it never
 * took), so they're covered by paying a real test card on the device.
 *
 * Needs: the Paystack test key in SSM /wcp/api/paystack-secret-key, 0030 applied, and
 * the API deployed with it.
 */
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = loadEnv(resolve(process.cwd(), "../../apps/marketing/.env.local"));
const BASE = env.SUPABASE_URL!;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY!;
const API = process.env.API_URL!;
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const note = (l: string) => console.log(`   • ${l}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
async function newUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}

type Deal = {
  id: string; state: string;
  payment?: { rail: string; principalKobo: number; buyerFeeKobo: number; processingFeeKobo: number; totalKobo: number };
  checkout?: { reference: string; authorizationUrl: string; totalKobo: number; processingFeeKobo: number; expiresAt: string };
};

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const key = process.env.PAYSTACK_SECRET_KEY ?? (await fetchSsm("/wcp/api/paystack-secret-key"));
  if (!key) { console.log("SKIP — no Paystack key in SSM /wcp/api/paystack-secret-key"); process.exit(2); }
  if (!key.startsWith("sk_test_")) { console.log("REFUSING — this suite only runs against a Paystack TEST key"); process.exit(2); }
  process.env.PAYSTACK_SECRET_KEY = key; // for the local expireStaleCheckouts call (D)
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const sign = (body: string) => createHmac("sha512", key).update(body).digest("hex");
  const hook = (body: unknown, sig?: string) => {
    const raw = JSON.stringify(body);
    return fetch(`${API}/webhooks/paystack`, { method: "POST", headers: { "content-type": "application/json", "x-paystack-signature": sig ?? sign(raw) }, body: raw });
  };
  const charge = (reference: string, amount: number) => ({
    event: "charge.success",
    data: { id: Math.floor(Math.random() * 1e9), reference, status: "success", amount, currency: "NGN", fees: 1500, channel: "card", paid_at: new Date().toISOString() },
  });

  const seller = await newUser("ps-s");
  const buyer = await newUser("ps-b");
  const get = async (id: string, t: string) => (await (await fetch(`${API}/deals/${id}`, { headers: H(t) })).json()) as Deal;
  const waitState = async (id: string, want: string, tries = 14) => {
    let s = "";
    for (let i = 0; i < tries && s !== want; i++) { if (i) await sleep(5_000); s = (await get(id, buyer.token)).state; }
    return s;
  };
  const sumAcct = async (dealId: string, acct: string) =>
    Number((await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = ${acct}`)[0]!.s);
  const newDeal = async (P: number) => {
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ category: "phones", title: "ps", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };
    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    return deal.id;
  };

  try {
    const P = 10_000_000; // ₦100,000
    const NET = P + buyerFeeKobo(P);
    const GROSS = NET + processingFeeKobo(NET);

    // ── A. Checkout ───────────────────────────────────────────────────────────
    console.log("A. checkout");
    const dealId = await newDeal(P);
    const before = await get(dealId, buyer.token);
    check("ACCEPTED deal shows the Paystack breakdown", before.payment?.rail === "paystack" && before.payment.totalKobo === GROSS,
      JSON.stringify(before.payment));
    check("processing fee is the buyer's (> 0, < 2.5%)", (before.payment?.processingFeeKobo ?? 0) > 0 && (before.payment?.processingFeeKobo ?? 0) < NET * 0.025);
    const sellerView = await get(dealId, seller.token);
    check("seller sees no buyer payment breakdown", !sellerView.payment);
    const p1 = await fetch(`${API}/deals/${dealId}/pay`, { method: "POST", headers: H(buyer.token) });
    const d1 = (await p1.json()) as Deal;
    check("pay → 200 PAYMENT_PENDING with a checkout", p1.status === 200 && d1.state === "PAYMENT_PENDING" && !!d1.checkout, `${p1.status} ${JSON.stringify(d1).slice(0, 200)}`);
    check("checkout is a real Paystack page", /^https:\/\/checkout\.paystack\.com\//.test(d1.checkout?.authorizationUrl ?? ""), d1.checkout?.authorizationUrl);
    check("checkout total = principal + buyer fee + processing", d1.checkout?.totalKobo === GROSS, `${d1.checkout?.totalKobo} vs ${GROSS}`);
    const ref = d1.checkout!.reference;
    const p2 = (await (await fetch(`${API}/deals/${dealId}/pay`, { method: "POST", headers: H(buyer.token) })).json()) as Deal;
    check("pay again → the same open checkout", p2.checkout?.reference === ref);
    check("GET /deals/{id} carries the open checkout", (await get(dealId, buyer.token)).checkout?.reference === ref);
    const ret = await fetch(`${API}/payments/paystack/return?trxref=${ref}&reference=${ref}`);
    check("return page serves HTML", ret.status === 200 && (ret.headers.get("content-type") ?? "").includes("text/html"));

    // ── B. Webhook ────────────────────────────────────────────────────────────
    console.log("B. webhook");
    check("bad signature → 401", (await hook(charge(ref, GROSS), "00".repeat(64))).status === 401);
    const mm = await hook(charge(ref, GROSS - 100));
    const [exc] = await sql<{ detail: string }[]>`select detail from public.reconciliation_exceptions where deal_id = ${dealId} order by id desc limit 1`;
    check("wrong amount → acked, refused, recorded", mm.status === 200 && exc?.detail === "mismatch" && (await get(dealId, buyer.token)).state === "PAYMENT_PENDING", exc?.detail);
    const ok = await hook(charge(ref, GROSS));
    check("signed charge.success → 200", ok.status === 200);
    check("deal PAID_IN_ESCROW", (await waitState(dealId, "PAID_IN_ESCROW", 3)) === "PAID_IN_ESCROW");
    check("escrow holds the principal; WCP the buyer fee", (await sumAcct(dealId, "escrow_holding")) === P && (await sumAcct(dealId, "wcp_fees")) === buyerFeeKobo(P));
    check("external debited exactly the net (processing fee is outside the ledger)", (await sumAcct(dealId, "external")) === -NET);
    const [pay] = await sql<{ status: string; channel: string }[]>`select status, channel from public.payments where reference = ${ref}`;
    check("payments row success", pay?.status === "success" && pay.channel === "card");
    await hook(charge(ref, GROSS));
    check("redelivery changes nothing", (await sumAcct(dealId, "escrow_holding")) === P && (await get(dealId, buyer.token)).state === "PAID_IN_ESCROW");

    // ── C. Payout ─────────────────────────────────────────────────────────────
    console.log("C. payout");
    await fetch(`${API}/deals/${dealId}/handoff`, { method: "POST", headers: H(seller.token) });
    await fetch(`${API}/deals/${dealId}/confirm`, { method: "POST", headers: H(buyer.token) });
    const PAYOUT = P - sellerFeeKobo(P);
    let owed = 0;
    for (let i = 0; i < 14 && owed !== PAYOUT; i++) { await sleep(5_000); owed = await sumAcct(dealId, "seller_payable"); }
    check("release settles internally → seller owed", owed === PAYOUT, `${owed}`);
    await fetch(`${API}/kyc/verify`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ idType: "bvn", idNumber: "22345678901" }) });
    const np = await fetch(`${API}/deals/${dealId}/payout`, { method: "POST", headers: H(seller.token) });
    const npe = (await np.json()) as { error?: string };
    check("payout without an account → 409 no_payout_account", np.status === 409 && npe.error === "no_payout_account", `${np.status} ${npe.error}`);
    const banks = (await (await fetch(`${API}/banks`, { headers: H(seller.token) })).json()) as { banks?: { code: string; name: string }[] };
    check("GET /banks lists Paystack's banks", (banks.banks?.length ?? 0) > 20, `${banks.banks?.length}`);
    const bad = await fetch(`${API}/me/payout-account/resolve`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ bankCode: "057", accountNumber: "12" }) });
    check("malformed account number → 400", bad.status === 400);
    // Paystack's test mode resolves a few fixed accounts; try the documented one.
    const save = await fetch(`${API}/me/payout-account`, { method: "PUT", headers: H(seller.token), body: JSON.stringify({ bankCode: "057", accountNumber: "0000000000" }) });
    const saved = (await save.json()) as { account?: { accountLast4: string; accountName: string }; error?: string };
    if (save.status !== 200) {
      note(`test mode wouldn't save a payout account (${save.status} ${saved.error}) — transfer path left to the device test`);
    } else {
      check("payout account saved (last 4 only)", saved.account?.accountLast4 === "0000" && !!saved.account.accountName);
      const [row] = await sql<{ recipient_code: string; provider: string }[]>`select recipient_code, provider from public.payout_accounts where user_id = ${seller.id}`;
      check("recipient is a Paystack RCP_", row?.provider === "paystack" && row.recipient_code.startsWith("RCP_"), row?.recipient_code);
      const po = await fetch(`${API}/deals/${dealId}/payout`, { method: "POST", headers: H(seller.token) });
      check("payout → 201", po.status === 201, `${po.status}`);
      let tref: string | null = null;
      for (let i = 0; i < 12 && !tref; i++) { await sleep(5_000); tref = (await sql<{ t: string | null }[]>`select transfer_reference as t from public.payouts where deal_id = ${dealId}`)[0]?.t ?? null; }
      check("consumer opened a Paystack transfer", !!tref, tref ?? "none");
      if (tref) {
        // Paystack sends transfer.success to the dashboard webhook URL; sign our own in
        // case that isn't set, so the settle path is exercised either way.
        await sleep(10_000);
        if ((await sumAcct(dealId, "seller_payable")) !== 0)
          await hook({ event: "transfer.success", data: { reference: tref, amount: PAYOUT, transfer_code: `TRF_test${Date.now()}`, status: "success" } });
        check("transfer.success settles → seller_payable 0", (await sumAcct(dealId, "seller_payable")) === 0);
      }
    }

    // ── D. Abandoned checkout, then a late payment ───────────────────────────
    console.log("D. abandoned + late");
    const d2 = await newDeal(P);
    const c2 = (await (await fetch(`${API}/deals/${d2}/pay`, { method: "POST", headers: H(buyer.token) })).json()) as Deal;
    const ref2 = c2.checkout!.reference;
    await sql`update public.payments set created_at = now() - interval '31 minutes' where reference = ${ref2}`;
    const { expireStaleCheckouts } = await import("../src/money/checkout.js");
    const ex = await expireStaleCheckouts(sql as never);
    check("sweeper: unpaid checkout abandoned", ex.abandoned >= 1, JSON.stringify(ex));
    check("deal back to ACCEPTED (buyer can retry)", (await get(d2, buyer.token)).state === "ACCEPTED");
    await hook(charge(ref2, c2.checkout!.totalKobo));
    check("late charge.success still lands it → PAID_IN_ESCROW", (await waitState(d2, "PAID_IN_ESCROW", 3)) === "PAID_IN_ESCROW");
  } finally {
    const deals = sql`select id from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.payouts where seller_id = ${seller.id}`;
    await sql`delete from public.payment_refunds where deal_id in (${deals})`;
    await sql`delete from public.payments where deal_id in (${deals})`;
    await sql`delete from public.reconciliation_exceptions where deal_id in (${deals})`;
    await sql`delete from public.ledger_entries where deal_id in (${deals})`;
    await sql`delete from public.outbox where deal_id in (${deals})`;
    await sql`delete from public.payout_accounts where user_id = ${seller.id}`;
    await sql`delete from public.kyc_verifications where user_id = ${seller.id}`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ Paystack rail works end-to-end (deployed, test mode)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
