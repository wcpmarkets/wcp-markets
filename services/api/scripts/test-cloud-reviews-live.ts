import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * M7 live — reviews on the DEPLOYED API: complete a deal, buyer reviews it, non-buyer
 * is blocked, duplicate blocked, seller replies once, public read + seller aggregate,
 * and the API rejects a review on a not-completed deal.
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
  const seller = await newUser("lr-s");
  const buyer = await newUser("lr-b");
  const other = await newUser("lr-o");
  const st = async (id: string, t: string) => ((await (await fetch(`${API}/deals/${id}`, { headers: H(t) })).json()) as { state: string }).state;
  try {
    const P = 18_000_000;
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ category: "phones", title: "lr", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };
    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    await fetch(`${API}/deals/${deal.id}/pay`, { method: "POST", headers: H(buyer.token) });

    // API rejects a review before the deal is completed
    const early = await fetch(`${API}/deals/${deal.id}/review`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ rating: 5 }) });
    check("review before completion → 409 deal_not_completed", early.status === 409, `${early.status}`);

    let s = "PAYMENT_PENDING";
    for (let i = 0; i < 14 && s !== "PAID_IN_ESCROW"; i++) { await sleep(10_000); s = await st(deal.id, buyer.token); }
    check("reached PAID_IN_ESCROW", s === "PAID_IN_ESCROW", s);
    await fetch(`${API}/deals/${deal.id}/handoff`, { method: "POST", headers: H(seller.token) });
    const cf = await fetch(`${API}/deals/${deal.id}/confirm`, { method: "POST", headers: H(buyer.token) });
    check("deal COMPLETED", ((await cf.json()) as { state: string }).state === "COMPLETED");

    const rv = await fetch(`${API}/deals/${deal.id}/review`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ rating: 5, body: "smooth deal" }) });
    const review = (await rv.json()) as { rating: number; sellerId: string };
    check("buyer POST /review → 201", rv.status === 201 && review.rating === 5, `${rv.status}`);
    check("review sellerId is the seller", review.sellerId === seller.id);

    check("non-buyer review → 404", (await fetch(`${API}/deals/${deal.id}/review`, { method: "POST", headers: H(other.token), body: JSON.stringify({ rating: 1 }) })).status === 404);
    check("duplicate review → 409", (await fetch(`${API}/deals/${deal.id}/review`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ rating: 4 }) })).status === 409);

    const rp = await fetch(`${API}/deals/${deal.id}/review/reply`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ reply: "thanks!" }) });
    check("seller reply → 200", rp.status === 200 && ((await rp.json()) as { sellerReply: string }).sellerReply === "thanks!");
    check("second reply → 409", (await fetch(`${API}/deals/${deal.id}/review/reply`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ reply: "again" }) })).status === 409);
    check("non-seller reply → 404", (await fetch(`${API}/deals/${deal.id}/review/reply`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ reply: "no" }) })).status === 404);

    // public reads (no auth)
    const pub = await fetch(`${API}/deals/${deal.id}/review`);
    check("public GET /deals/{id}/review (no auth) → 200 with reply", pub.status === 200 && ((await pub.json()) as { sellerReply: string }).sellerReply === "thanks!");
    const sr = await fetch(`${API}/sellers/${seller.id}/reviews`);
    const agg = (await sr.json()) as { count: number; averageRating: number };
    check("seller reviews aggregate: count 1, avg 5", sr.status === 200 && agg.count === 1 && agg.averageRating === 5, `${agg.count}/${agg.averageRating}`);
  } finally {
    await sql`delete from public.reviews where seller_id = ${seller.id}`;
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer, other]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M7 reviews work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
