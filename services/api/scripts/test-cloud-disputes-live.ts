import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * M6 live — the dispute flow on the DEPLOYED API: buyer opens a dispute → staff
 * queue → non-staff is forbidden → seller responds → support ADMIN resolves (refund)
 * → async refund settlement → buyer made whole. Exercises the routes, the DB-backed
 * staff_roles authz, and the escrow settlement path end to end.
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
  const seller = await newUser("ld-s");
  const buyer = await newUser("ld-b");
  const adminU = await newUser("ld-admin");
  const nonStaff = await newUser("ld-non");
  const dealState = async (id: string, t: string) => ((await (await fetch(`${API}/deals/${id}`, { headers: H(t) })).json()) as { state: string }).state;
  try {
    await sql`insert into public.staff_roles (user_id, role) values (${adminU.id}, 'admin') on conflict (user_id) do update set role = 'admin'`;
    const P = 22_000_000;
    const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ category: "phones", title: "ld", priceKobo: P, stock: 1 }) });
    const listing = (await lr.json()) as { id: string };
    const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: P }) });
    const deal = (await or.json()) as { id: string };
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    await fetch(`${API}/deals/${deal.id}/pay`, { method: "POST", headers: H(buyer.token) });
    let s = "PAYMENT_PENDING";
    for (let i = 0; i < 14 && s !== "PAID_IN_ESCROW"; i++) { await sleep(10_000); s = await dealState(deal.id, buyer.token); }
    check("reached PAID_IN_ESCROW", s === "PAID_IN_ESCROW", s);

    const dr = await fetch(`${API}/deals/${deal.id}/dispute`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ reason: "item not as described", evidence: "photo attached" }) });
    const dcase = (await dr.json()) as { status: string };
    check("buyer POST /dispute → 201 open", dr.status === 201 && dcase.status === "open", `${dr.status}/${dcase.status}`);
    check("deal is DISPUTED", (await dealState(deal.id, buyer.token)) === "DISPUTED");

    const q = await fetch(`${API}/admin/disputes`, { headers: H(adminU.token) });
    const queue = (await q.json()) as { dealId: string }[];
    check("staff sees the dispute in the queue", q.status === 200 && queue.some((x) => x.dealId === deal.id));
    check("non-staff GET /admin/disputes → 403", (await fetch(`${API}/admin/disputes`, { headers: H(nonStaff.token) })).status === 403);

    const badResolve = await fetch(`${API}/deals/${deal.id}/dispute/resolve`, { method: "POST", headers: H(nonStaff.token), body: JSON.stringify({ resolution: "refund" }) });
    check("non-staff resolve → 403 (deal untouched)", badResolve.status === 403 && (await dealState(deal.id, buyer.token)) === "DISPUTED");

    const rr = await fetch(`${API}/deals/${deal.id}/dispute/respond`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ response: "it was sealed", evidence: "receipt" }) });
    check("seller POST /respond → 200 responded", rr.status === 200 && ((await rr.json()) as { status: string }).status === "responded");
    check("deal is DISPUTED_RESPONDED", (await dealState(deal.id, buyer.token)) === "DISPUTED_RESPONDED");

    const res = await fetch(`${API}/deals/${deal.id}/dispute/resolve`, { method: "POST", headers: H(adminU.token), body: JSON.stringify({ resolution: "refund", note: "buyer favoured" }) });
    const resolved = (await res.json()) as { status: string; resolution: string; resolvedBy: string };
    check("admin resolve refund → 200 resolved", res.status === 200 && resolved.status === "resolved" && resolved.resolution === "refund", `${res.status}/${resolved.status}`);
    check("resolution attributed to the admin rep", resolved.resolvedBy === adminU.id);
    check("deal is REFUNDED", (await dealState(deal.id, buyer.token)) === "REFUNDED");

    let esc = P;
    for (let i = 0; i < 14 && esc !== 0; i++) {
      await sleep(10_000);
      esc = Number((await sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${deal.id} and account = 'escrow_holding'`)[0]!.s);
    }
    check("async refund settled → buyer made whole (escrow 0)", esc === 0, `${esc}`);
  } finally {
    await sql`delete from public.dispute_cases where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql`delete from public.staff_roles where user_id = ${adminU.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer, adminU, nonStaff]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M6 dispute flow works end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
