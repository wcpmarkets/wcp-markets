import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * 7h-counter-diff + 20h-decline live (0042): deal events record the hand-off terms,
 * and a decline takes a canned reason.
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-negotiation.ts
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

async function call(tok: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${tok}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json };
}

async function main() {
  if (!API) throw new Error("missing API_URL");
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("neg-s");
  const buyer = await newUser("neg-b");
  const P = 9_000_000;
  const FEE = 150_000;
  try {
    const mk = async (t: string) => (await call(seller.token, "POST", "/listings", {
      category: "phones", title: t, priceKobo: P, stock: 1, state: "Lagos", city: "Yaba",
      attributes: { delivery: { modes: ["deliver", "meet"], states: ["Lagos"] } },
    })).body.id as string;

    console.log("1) counter diff: events carry the delivery terms (0042)");
    const L1 = await mk("neg diff");
    const o = await call(buyer.token, "POST", `/listings/${L1}/offers`, { priceKobo: P, delivery: { method: "deliver", state: "Lagos", place: "Yaba" } });
    const D = o.body.id as string;
    await call(seller.token, "PUT", `/deals/${D}/delivery-fee`, { feeKobo: FEE });
    const ct = await call(seller.token, "POST", `/deals/${D}/actions`, { action: "counter", priceKobo: P - 500_000 });
    check("seller counter → 200", ct.status === 200, `${ct.status}`);
    const det = await call(buyer.token, "GET", `/deals/${D}`);
    const ev = det.body.events as any[];
    check("offer event records method deliver, no fee yet", ev[0]?.deliveryMethod === "deliver" && ev[0]?.deliveryFeeKobo == null, JSON.stringify(ev[0]));
    const last = ev[ev.length - 1];
    check("counter event records the pinned fee", last?.action === "counter" && last?.deliveryFeeKobo === FEE && last?.priceKobo === P - 500_000, JSON.stringify(last));

    console.log("2) decline with a canned reason (20h-decline)");
    const bad = await call(seller.token, "POST", `/deals/${D}/actions`, { action: "accept", reason: "price_too_low" });
    check("reason on a non-decline → 400", bad.status === 400 && bad.body?.error === "reason_only_on_decline", `${bad.status} ${JSON.stringify(bad.body)}`);
    const junk = await call(seller.token, "POST", `/deals/${D}/actions`, { action: "decline", reason: "you smell" });
    check("unknown reason → 400", junk.status === 400, `${junk.status}`);
    // Only the seller declines: the buyer counters back first.
    const bc = await call(buyer.token, "POST", `/deals/${D}/actions`, { action: "counter", priceKobo: P - 900_000 });
    check("buyer counters back", bc.status === 200 && bc.body.state === "COUNTERED_BY_BUYER", `${bc.status}`);
    const dec = await call(seller.token, "POST", `/deals/${D}/actions`, { action: "decline", reason: "price_too_low" });
    check("seller declines with a reason → DECLINED", dec.status === 200 && dec.body.state === "DECLINED", `${dec.status} ${dec.body?.state ?? JSON.stringify(dec.body)}`);
    const d2 = await call(seller.token, "GET", `/deals/${D}`);
    const end = (d2.body.events as any[]).at(-1);
    check("the decline event carries the reason", end?.action === "decline" && end?.reason === "price_too_low", JSON.stringify(end));

    console.log("3) decline without a reason still works");
    const L2 = await mk("neg plain");
    const o2 = await call(buyer.token, "POST", `/listings/${L2}/offers`, { priceKobo: P, delivery: { method: "meet", place: "Yaba bus stop" } });
    check("second offer → 201", o2.status === 201, `${o2.status} ${JSON.stringify(o2.body)}`);
    const dp = await call(seller.token, "POST", `/deals/${o2.body.id}/actions`, { action: "decline" });
    check("plain decline → DECLINED", dp.status === 200 && dp.body.state === "DECLINED", `${dp.status}`);
    const ev2 = (await call(buyer.token, "GET", `/deals/${o2.body.id}`)).body.events as any[];
    check("meet offer records method meet, decline reason null", ev2[0]?.deliveryMethod === "meet" && ev2.at(-1)?.reason == null);
  } finally {
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.notifications where user_id = any(${[seller.id, buyer.id]})`;
    await sql`delete from public.messages where conversation_id in (select id from public.conversations where seller_id = ${seller.id})`;
    await sql`delete from public.conversations where seller_id = ${seller.id}`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`
VERDICT → ${pass ? "PASS ✅ counter diff terms + decline reasons work end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
