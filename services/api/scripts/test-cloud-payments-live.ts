import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { buyerFeeKobo } from "../src/money/fees.js";

/**
 * M4 part 2 — the FULL async escrow loop against the DEPLOYED stack, no mocking of
 * the pipeline: buyer pays over HTTP → transactional outbox → sweeper relays to SQS →
 * consumer Lambda calls the Mock provider → signed webhook → /webhooks/escrow →
 * payment_confirmed → PAID_IN_ESCROW, with a balanced ledger. Proves M4 end-to-end.
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
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });

async function newUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST", headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}

async function main() {
  if (!API) throw new Error("missing API_URL");
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("live-pay-s");
  const buyer = await newUser("live-pay-b");
  try {
    const P = 30_000_000; // ₦300k
    const FEE = buyerFeeKobo(P);
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token),
      body: JSON.stringify({ category: "phones", title: "live-pay", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };

    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token),
      body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });

    const pr = await fetch(`${API}/deals/${deal.id}/pay`, { method: "POST", headers: H(buyer.token) });
    const paid = (await pr.json()) as { state: string };
    check("POST /pay → PAYMENT_PENDING", pr.status === 200 && paid.state === "PAYMENT_PENDING", `${pr.status}/${paid.state}`);
    console.log("0) paid; waiting for sweeper → SQS → consumer → webhook…");

    let state = "PAYMENT_PENDING";
    for (let i = 0; i < 14; i++) {
      await sleep(10_000);
      const d = await (await fetch(`${API}/deals/${deal.id}`, { headers: H(buyer.token) })).json() as { state: string };
      state = d.state;
      process.stdout.write(`   t+${(i + 1) * 10}s: ${state}\n`);
      if (state === "PAID_IN_ESCROW") break;
    }
    check("async loop reached PAID_IN_ESCROW", state === "PAID_IN_ESCROW", state);

    const groups = await sql<{ txn_group: string; s: number }[]>`
      select txn_group, sum(amount_kobo)::bigint as s from public.ledger_entries where deal_id = ${deal.id} group by txn_group`;
    check("ledger hold group balanced", groups.length === 1 && Number(groups[0]!.s) === 0, JSON.stringify(groups));
    const [esc] = await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'escrow_holding'`;
    check("escrow_holding = principal", Number(esc!.s) === P);
    const [fee] = await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'wcp_fees'`;
    check("wcp_fees = buyer fee", Number(fee!.s) === FEE, `${FEE}`);
    const [stock] = await sql<{ stock: number }[]>`select stock from public.listings where id = ${listing.id}`;
    check("stock decremented to 0", stock!.stock === 0, `${stock!.stock}`);
  } finally {
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M4 full async escrow loop works end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
