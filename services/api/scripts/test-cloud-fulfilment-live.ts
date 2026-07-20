import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { buyerFeeKobo, sellerFeeKobo } from "../src/money/fees.js";

/**
 * M5 live — the full fulfilment loop on the DEPLOYED stack: pay → (async hold) →
 * PAID_IN_ESCROW → handoff → confirm → outbox → sweeper → SQS → consumer →
 * releaseToSeller → release.settled webhook → release ledger → seller_payable.
 * Two sweeper hops (hold, release), so it polls patiently.
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
  const seller = await newUser("liv-ful-s");
  const buyer = await newUser("liv-ful-b");
  const state = async (id: string, tok: string) => ((await (await fetch(`${API}/deals/${id}`, { headers: H(tok) })).json()) as { state: string }).state;
  try {
    const P = 25_000_000;
    const PAYOUT = P - sellerFeeKobo(P);
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ category: "phones", title: "liv-ful", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };
    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    await fetch(`${API}/deals/${deal.id}/pay`, { method: "POST", headers: H(buyer.token) });
    console.log("0) paid; waiting for async hold…");

    let s = "PAYMENT_PENDING";
    for (let i = 0; i < 14 && s !== "PAID_IN_ESCROW"; i++) { await sleep(10_000); s = await state(deal.id, buyer.token); process.stdout.write(`   hold t+${(i + 1) * 10}s: ${s}\n`); }
    check("reached PAID_IN_ESCROW", s === "PAID_IN_ESCROW", s);

    const ho = await fetch(`${API}/deals/${deal.id}/handoff`, { method: "POST", headers: H(seller.token) });
    check("POST /handoff → HANDED_OFF", ho.status === 200 && ((await ho.json()) as { state: string }).state === "HANDED_OFF");
    const cf = await fetch(`${API}/deals/${deal.id}/confirm`, { method: "POST", headers: H(buyer.token) });
    check("POST /confirm → COMPLETED", cf.status === 200 && ((await cf.json()) as { state: string }).state === "COMPLETED");
    console.log("3) confirmed; waiting for async release settlement…");

    let payable = 0;
    for (let i = 0; i < 14 && payable === 0; i++) {
      await sleep(10_000);
      payable = Number((await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'seller_payable'`)[0]!.s);
      process.stdout.write(`   release t+${(i + 1) * 10}s: seller_payable=${payable}\n`);
    }
    check("release settled → seller_payable = payout", payable === PAYOUT, `${payable} vs ${PAYOUT}`);
    check("escrow_holding nets to 0", Number((await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'escrow_holding'`)[0]!.s) === 0);
    const bad = Number((await sql<{ bad: number }[]>`select count(*) filter (where s <> 0)::int as bad from (select txn_group, sum(amount_kobo) as s from public.ledger_entries where deal_id = ${deal.id} group by txn_group) g`)[0]!.bad);
    check("all ledger groups balanced", bad === 0, `${bad} unbalanced`);
  } finally {
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M5 full fulfilment loop works end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
