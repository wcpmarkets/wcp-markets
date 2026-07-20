import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { sellerFeeKobo } from "../src/money/fees.js";

/**
 * M8 live — the payout GATE on the DEPLOYED API. Complete a deal, then: an unverified
 * seller's payout is REFUSED (403 kyc_required); after L2 KYC (Mock NIBSS BVN match)
 * the payout is accepted and settles (seller_payable → 0). Plus: the DB stores no
 * BVN/NIN.
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

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("lk-s");
  const buyer = await newUser("lk-b");
  const st = async (id: string, t: string) => ((await (await fetch(`${API}/deals/${id}`, { headers: H(t) })).json()) as { state: string }).state;
  try {
    const P = 20_000_000;
    const PAYOUT = P - sellerFeeKobo(P);
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ category: "phones", title: "lk", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };
    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    await fetch(`${API}/deals/${deal.id}/pay`, { method: "POST", headers: H(buyer.token) });
    let s = "PAYMENT_PENDING";
    for (let i = 0; i < 14 && s !== "PAID_IN_ESCROW"; i++) { await sleep(10_000); s = await st(deal.id, buyer.token); }
    check("reached PAID_IN_ESCROW", s === "PAID_IN_ESCROW", s);
    await fetch(`${API}/deals/${deal.id}/handoff`, { method: "POST", headers: H(seller.token) });
    await fetch(`${API}/deals/${deal.id}/confirm`, { method: "POST", headers: H(buyer.token) });
    check("deal COMPLETED", (await st(deal.id, buyer.token)) === "COMPLETED");
    // wait for the release to settle (seller is now OWED)
    let owed = 0;
    for (let i = 0; i < 14 && owed === 0; i++) { await sleep(10_000); owed = Number((await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'seller_payable'`)[0]!.s); }
    check("release settled → seller_payable = payout", owed === PAYOUT, `${owed}`);

    // ── THE GATE: unverified seller cannot be paid out ─────────────────────────
    const kyc0 = await fetch(`${API}/kyc`, { headers: H(seller.token) });
    check("seller starts at L1 (unverified)", ((await kyc0.json()) as { level: number }).level === 1);

    // ── Fable #1: the KYC bypass must be closed — a client cannot self-set L2 ────
    await fetch(`${API}/me`, { headers: H(seller.token) }); // ensure the profile row exists (L1)
    const bypass = await fetch(`${BASE}/rest/v1/profiles?id=eq.${seller.id}`, {
      method: "PATCH",
      headers: { apikey: seller.token, Authorization: `Bearer ${seller.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ verification_level: 2 }),
    });
    const lvlAfterBypass = ((await (await fetch(`${API}/kyc`, { headers: H(seller.token) })).json()) as { level: number }).level;
    check("client PATCH of verification_level is blocked (KYC bypass closed)", lvlAfterBypass === 1, `http ${bypass.status}, level ${lvlAfterBypass}`);

    const blocked = await fetch(`${API}/deals/${deal.id}/payout`, { method: "POST", headers: H(seller.token) });
    check("payout while L1 → 403 kyc_required", blocked.status === 403 && ((await blocked.json()) as { error: string }).error === "kyc_required", `${blocked.status}`);

    // ── L2 KYC (Mock NIBSS) ────────────────────────────────────────────────────
    const kv = await fetch(`${API}/kyc/verify`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ idType: "bvn", idNumber: "22345678901" }) });
    const kres = (await kv.json()) as { level: number; matched: boolean };
    check("KYC verify (valid BVN) → matched, L2", kv.status === 200 && kres.matched === true && kres.level === 2);
    check("GET /kyc now reports L2", ((await (await fetch(`${API}/kyc`, { headers: H(seller.token) })).json()) as { level: number }).level === 2);

    // ── Now the payout goes through ────────────────────────────────────────────
    const pay = await fetch(`${API}/deals/${deal.id}/payout`, { method: "POST", headers: H(seller.token) });
    const payout = (await pay.json()) as { status: string; amountKobo: number };
    check("payout while L2 → 201", pay.status === 201 && payout.amountKobo === PAYOUT, `${pay.status}`);
    let payable = PAYOUT;
    for (let i = 0; i < 14 && payable !== 0; i++) { await sleep(10_000); payable = Number((await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'seller_payable'`)[0]!.s); }
    check("payout settled → seller_payable nets to 0", payable === 0, `${payable}`);
    check("payout row settled", ((await (await fetch(`${API}/deals/${deal.id}/payout`, { headers: H(seller.token) })).json()) as { status: string }).status === "settled");

    // ── The DB stores no BVN/NIN ───────────────────────────────────────────────
    const rowText = JSON.stringify((await sql`select * from public.kyc_verifications where user_id = ${seller.id}`)[0] ?? {});
    check("stored KYC row contains no id number", !rowText.includes("22345678901"));
  } finally {
    await sql`delete from public.payouts where seller_id = ${seller.id}`;
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.kyc_verifications where user_id = ${seller.id}`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M8 payout-gated on L2 KYC works end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
