import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Delivery terms (0040) end-to-end against the DEPLOYED API, on the mock rail:
 * listing delivery guard + details + search filters, offer validation, coverage
 * request → seller adds the state, fee pending blocks Pay, seller pins the fee,
 * stale total refused, pay → escrow holds items + fee, hand-off window, a counter to
 * a new destination clears the fee, and a stranger can't touch any of it.
 * Throwaway clitest+ accounts; everything is deleted at the end.
 *
 *   API_URL=https://… tsx scripts/test-cloud-delivery.ts
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
  const seller = await newUser("dlv-s");
  const buyer = await newUser("dlv-b");
  const stranger = await newUser("dlv-x");
  const P = 9_000_000; // ₦90,000 for the items
  const FEE = 250_000; // ₦2,500 delivery
  try {
    console.log("1) listing guard, details, search");
    const bare = await call(seller.token, "POST", "/listings", { category: "phones", title: "dlv bare", priceKobo: P });
    check("goods listing without delivery → 422", bare.status === 422 && bare.body?.error === "goods_needs_delivery_mode", `${bare.status} ${JSON.stringify(bare.body)}`);
    const tag = `dlvtest${Date.now()}`;
    const lr = await call(seller.token, "POST", "/listings", {
      category: "phones", title: `Galaxy ${tag}`, priceKobo: P, stock: 2, state: "Lagos", city: "Ikeja", location: "Ikeja, Lagos",
      attributes: { delivery: { modes: ["deliver", "meet"], states: ["Lagos"] }, brand: "Samsung", storage: "128GB", warranty: "6m" },
    });
    check("goods listing with delivery + details → 201", lr.status === 201, `${lr.status} ${JSON.stringify(lr.body).slice(0, 160)}`);
    const L = lr.body.id as string;
    const s1 = await call(buyer.token, "GET", `/listings/search?q=${tag}&brand=samsung&storage=128GB&warranty=true&delivery=deliver`);
    check("search finds it by brand/storage/warranty/delivery", s1.body?.items?.some((i: any) => i.id === L), `${s1.status}`);
    const s2 = await call(buyer.token, "GET", `/listings/search?q=${tag}&delivery=pickup`);
    check("search delivery=pickup excludes it", s2.status === 200 && !s2.body.items.some((i: any) => i.id === L));
    const ed = await call(seller.token, "PATCH", `/listings/${L}`, { goodsDetails: { clear: ["storage"], ram: "8GB" } });
    check("edit: clear storage, set ram", ed.status === 200 && ed.body.attributes?.storage == null && ed.body.attributes?.ram === "8GB" && ed.body.attributes?.brand === "Samsung",
      JSON.stringify(ed.body.attributes ?? ed.body));

    console.log("2) offer validation");
    const o1 = await call(buyer.token, "POST", `/listings/${L}/offers`, { priceKobo: P, delivery: { method: "deliver", state: "Ogun", place: "Abeokuta" } });
    check("deliver outside coverage → 422", o1.status === 422 && o1.body?.error === "outside_delivery_coverage", `${o1.status} ${JSON.stringify(o1.body)}`);
    const o2 = await call(buyer.token, "POST", `/listings/${L}/offers`, { priceKobo: P, delivery: { method: "meet" } });
    check("meet without a place → 422", o2.status === 422 && o2.body?.error === "meet_needs_place", `${o2.status}`);
    const o3 = await call(buyer.token, "POST", `/listings/${L}/offers`, { priceKobo: P, delivery: { method: "pickup" } });
    check("pickup not offered → 422", o3.status === 422 && o3.body?.error === "delivery_method_not_offered", `${o3.status}`);

    console.log("3) coverage request → seller adds the state");
    const cv = await call(buyer.token, "POST", `/listings/${L}/conversations`);
    const C = cv.body?.id as string;
    check("conversation opened", !!C, `${cv.status}`);
    const rq = await call(buyer.token, "POST", `/conversations/${C}/coverage-request`, { state: "Ogun" });
    check("coverage request → 201 card", rq.status === 201 && rq.body.kind === "coverage_request" && rq.body.meta?.status === "pending", `${rq.status} ${JSON.stringify(rq.body).slice(0, 120)}`);
    const rq2 = await call(buyer.token, "POST", `/conversations/${C}/coverage-request`, { state: "Ogun" });
    check("repeat request hands back the same card", rq2.status === 201 && rq2.body.id === rq.body.id);
    const rqx = await call(stranger.token, "POST", `/conversations/${C}/coverage-request`, { state: "Oyo" });
    check("stranger can't post a request → 404", rqx.status === 404, `${rqx.status}`);
    const rpb = await call(buyer.token, "POST", `/conversations/${C}/coverage-reply`, { state: "Ogun", accept: true });
    check("buyer can't answer it", rpb.status === 404 || rpb.status === 403, `${rpb.status}`);
    const rp = await call(seller.token, "POST", `/conversations/${C}/coverage-reply`, { state: "Ogun", accept: true, feeKobo: FEE });
    check("seller adds Ogun → 201 reply card", rp.status === 201 && rp.body.kind === "coverage_reply", `${rp.status} ${JSON.stringify(rp.body).slice(0, 120)}`);
    const lg = await call(buyer.token, "GET", `/listings/${L}`);
    check("listing now delivers to Ogun", lg.body.attributes?.delivery?.states?.includes("Ogun"), JSON.stringify(lg.body.attributes?.delivery));
    const msgs = await call(buyer.token, "GET", `/conversations/${C}/messages`);
    const list = (msgs.body?.items ?? msgs.body) as any[];
    const req = Array.isArray(list) ? list.find((m) => m.id === rq.body.id) : null;
    check("request card marked accepted", req?.meta?.status === "accepted", JSON.stringify(req?.meta));

    console.log("4) fee pending blocks Pay; seller pins the fee");
    const of = await call(buyer.token, "POST", `/listings/${L}/offers`, { priceKobo: P, qty: 1, delivery: { method: "deliver", state: "Ogun", place: "Abeokuta", when: "Sat" } });
    check("deliver to Ogun offer → 201", of.status === 201, `${of.status} ${JSON.stringify(of.body).slice(0, 160)}`);
    const D = of.body.id as string;
    check("fee not set yet", of.body.delivery?.method === "deliver" && of.body.delivery?.feeKobo == null, JSON.stringify(of.body.delivery));
    const ac = await call(seller.token, "POST", `/deals/${D}/actions`, { action: "accept" });
    check("seller accepts", ac.status === 200 && ac.body.state === "ACCEPTED", `${ac.status}`);
    const pz = await call(buyer.token, "POST", `/deals/${D}/pay`, {});
    check("Pay refused while fee pending → 409", pz.status === 409 && pz.body?.error === "delivery_fee_pending", `${pz.status} ${JSON.stringify(pz.body)}`);
    const fx = await call(stranger.token, "PUT", `/deals/${D}/delivery-fee`, { feeKobo: FEE });
    check("stranger can't set the fee", fx.status === 404 || fx.status === 403, `${fx.status}`);
    const fb = await call(buyer.token, "PUT", `/deals/${D}/delivery-fee`, { feeKobo: 1 });
    check("buyer can't set the fee", fb.status === 404 || fb.status === 403 || fb.status === 409, `${fb.status}`);
    const before = await call(buyer.token, "GET", `/deals/${D}`);
    const f1 = await call(seller.token, "PUT", `/deals/${D}/delivery-fee`, { feeKobo: FEE });
    check("seller pins the fee", f1.status === 200 && f1.body.delivery?.feeKobo === FEE, `${f1.status} ${JSON.stringify(f1.body.delivery)}`);
    const after = await call(buyer.token, "GET", `/deals/${D}`);
    check("deal total includes the fee", after.body.payment?.totalKobo > (before.body.payment?.totalKobo ?? 0),
      `${before.body.payment?.totalKobo} → ${after.body.payment?.totalKobo}`);
    const msgs2 = await call(buyer.token, "GET", `/conversations/${C}/messages`);
    const l2 = (msgs2.body?.items ?? msgs2.body) as any[];
    check("fee card posted in chat", Array.isArray(l2) && l2.some((m) => m.kind === "delivery_fee" && m.meta?.feeKobo === FEE));

    console.log("5) stale total refused; pay → escrow holds items + fee");
    const stale = await call(buyer.token, "POST", `/deals/${D}/pay`, { expectedTotalKobo: before.body.payment?.totalKobo ?? 1 });
    check("stale expected total → 409 total_changed", stale.status === 409 && stale.body?.error === "total_changed", `${stale.status} ${JSON.stringify(stale.body)}`);
    const pay = await call(buyer.token, "POST", `/deals/${D}/pay`, { expectedTotalKobo: after.body.payment.totalKobo });
    check("pay with the current total → PAYMENT_PENDING", pay.status === 200 && pay.body.state === "PAYMENT_PENDING", `${pay.status} ${JSON.stringify(pay.body).slice(0, 120)}`);
    const lateFee = await call(seller.token, "PUT", `/deals/${D}/delivery-fee`, { feeKobo: FEE * 2 });
    check("fee locked once payment starts", lateFee.status === 409, `${lateFee.status}`);
    let state = pay.body.state;
    for (let i = 0; i < 14 && state !== "PAID_IN_ESCROW"; i++) {
      await sleep(10_000);
      state = (await call(buyer.token, "GET", `/deals/${D}`)).body.state;
      process.stdout.write(`   t+${(i + 1) * 10}s: ${state}\n`);
    }
    check("reached PAID_IN_ESCROW", state === "PAID_IN_ESCROW", state);
    const [esc] = await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${D} and account = 'escrow_holding'`;
    check("escrow_holding = items + fee", Number(esc!.s) === P + FEE, `${esc!.s} vs ${P + FEE}`);

    console.log("6) hand-off window");
    const hw = await call(seller.token, "PUT", `/deals/${D}/handoff-window`, { window: "Sat 2–5pm" });
    check("seller confirms window", hw.status === 200 && hw.body.delivery?.window === "Sat 2–5pm", `${hw.status} ${JSON.stringify(hw.body.delivery ?? hw.body)}`);
    const hwb = await call(buyer.token, "PUT", `/deals/${D}/handoff-window`, { window: "now" });
    check("buyer can't set the window", hwb.status !== 200, `${hwb.status}`);
    const msgs3 = await call(seller.token, "GET", `/conversations/${C}/messages`);
    const l3 = (msgs3.body?.items ?? msgs3.body) as any[];
    check("window card posted in chat", Array.isArray(l3) && l3.some((m) => m.kind === "handoff_window"));

    console.log("7) counter to a new destination clears the fee");
    // A fresh listing: the buyer's paid deal is still the open one on the first.
    const lb = await call(seller.token, "POST", "/listings", {
      category: "phones", title: `Galaxy b ${Date.now()}`, priceKobo: P, state: "Lagos", city: "Ikeja",
      attributes: { delivery: { modes: ["deliver"], states: ["Lagos", "Ogun"] } },
    });
    const o4 = await call(buyer.token, "POST", `/listings/${lb.body.id}/offers`, { priceKobo: P, delivery: { method: "deliver", state: "Lagos", place: "Yaba" } });
    const D2 = o4.body.id as string;
    check("second offer → 201", o4.status === 201, `${o4.status} ${JSON.stringify(o4.body).slice(0, 120)}`);
    await call(seller.token, "PUT", `/deals/${D2}/delivery-fee`, { feeKobo: FEE });
    const ct = await call(seller.token, "POST", `/deals/${D2}/actions`, { action: "counter", priceKobo: P + 500_000 });
    check("seller counter on price keeps the fee", ct.status === 200 && ct.body.delivery?.feeKobo === FEE, `${ct.status} ${JSON.stringify(ct.body.delivery)}`);
    const cb = await call(buyer.token, "POST", `/deals/${D2}/actions`, { action: "counter", priceKobo: P, delivery: { method: "deliver", state: "Ogun", place: "Sagamu" } });
    check("buyer counter to Ogun clears the fee", cb.status === 200 && cb.body.delivery?.feeKobo == null && cb.body.delivery?.state === "Ogun", `${cb.status} ${JSON.stringify(cb.body.delivery ?? cb.body)}`);
    const sx = await call(stranger.token, "GET", `/deals/${D2}`);
    check("stranger can't see the deal", sx.status === 404, `${sx.status}`);
  } finally {
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.messages where conversation_id in (select id from public.conversations where seller_id = ${seller.id})`;
    await sql`delete from public.conversations where seller_id = ${seller.id}`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer, stranger]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ delivery terms work end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
