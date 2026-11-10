import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Phase 3 D live — the Services lane on the DEPLOYED API: posting a rate card,
 * service filters, quote-first (buyers can't offer), the quote request → provider
 * quote → counter → accept → escrow → job done → confirm & release loop, the
 * provider's request inbox, and the service clocks (48h quotes, escrow from the job
 * date, no stock decrement).
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-services.ts
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
const API = process.env.API_URL!.replace(/\/$/, "");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type U = { id: string; token: string };
async function newUser(tag: string): Promise<U> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}
const j = async <T>(r: Response) => (await r.json()) as T;
const api = (path: string, t: string | null, init: RequestInit = {}) =>
  fetch(`${API}${path}`, { ...init, headers: { ...(t ? H(t) : { "Content-Type": "application/json" }), ...(init.headers ?? {}) } });
const err = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "";

type Listing = { id: string; lane: string; stock: number; priceKobo: number; attributes: Record<string, unknown> };
type Req = { id: string; conversationId: string; stage: string; status: string; dealId: string | null; dealState: string | null; quotedKobo: number | null; startsAt: string | null };
type Deal = { id: string; state: string; priceKobo: number; terms?: { service: string; scope?: string | null; startsAt?: string | null } };
type Page = { items: Req[]; counts: { all: number; new: number; quoted: number; scheduled: number } };

const svc = (over: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => ({
  lane: "services",
  category: "Home Services",
  title: "Tunde Plumbing test",
  description: "10+ years across Lagos. Leaks, installs, full bathroom plumbing.",
  priceKobo: 999, // ignored: derived from the rate card
  state: "Lagos",
  city: "Yaba",
  attributes: {
    serviceType: "Plumbing",
    rateCard: [
      { name: "Leak repair & diagnosis", fromKobo: 8_000_00 },
      { name: "Water heater install", fromKobo: 15_000_00 },
      { name: "Full bathroom plumbing" },
    ],
    coverageKm: 5,
    availability: ["today", "emergency"],
    ...attrs,
  },
  ...over,
});

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const pro = await newUser("sv-p");
  const buyer = await newUser("sv-b");
  const other = await newUser("sv-o");
  const users = [pro, buyer, other];
  const post = (body: unknown) => api("/listings", pro.token, { method: "POST", body: JSON.stringify(body) });
  const deadline = async (dealId: string) =>
    (await sql<{ hours: number; action: string }[]>`
      select extract(epoch from (due_at - now())) / 3600 as hours, action
      from public.deal_deadlines where deal_id = ${dealId}`)[0];
  try {
    // ── Catalogue ─────────────────────────────────────────────────────────
    console.log("catalogue");
    const cat = await j<{ groups: { group: string; types: string[] }[]; coverageKm: number[]; availability: string[] }>(await api("/services/catalog", null));
    check("catalogue has Home Services → Plumbing", !!cat.groups.find((g) => g.group === "Home Services")?.types.includes("Plumbing"));
    check("…coverage rings 2/5/10 and three availability flags", cat.coverageKm.join() === "2,5,10" && cat.availability.length === 3);

    // ── Posting ───────────────────────────────────────────────────────────
    console.log("posting");
    const r1 = await post(svc());
    const L = await j<Listing>(r1);
    check("post a service → 201", r1.status === 201, `${r1.status}`);
    check("price is the cheapest 'from' line (₦8,000), one unit", L.priceKobo === 8_000_00 && L.stock === 1, `${L.priceKobo} ${L.stock}`);
    check("rate card round-trips, 'Quote' line has no price", Array.isArray(L.attributes.rateCard) && (L.attributes.rateCard as { fromKobo?: number }[])[2]!.fromKobo == null);
    const allQuote = await j<Listing>(await post(svc({ title: "Quote-only test" }, { rateCard: [{ name: "Site survey" }], coverageKm: undefined, coverageAnywhere: true })));
    check("all-quote rate card → price 0, anywhere coverage ok", allQuote.priceKobo === 0 && allQuote.attributes.coverageAnywhere === true);
    const noCov = await post(svc({}, { coverageKm: 7 }));
    check("coverage not 2/5/10 and not anywhere → 422", noCov.status === 422 && (await err(noCov)) === "service_needs_coverage");
    const noRates = await post(svc({}, { rateCard: [] }));
    check("empty rate card → 422", noRates.status === 422 && (await err(noRates)) === "service_needs_details");
    const badCat = await post(svc({ category: "Wizardry" }));
    check("unknown category → 422", badCat.status === 422 && (await err(badCat)) === "unknown_service_category");
    const noArea = await post(svc({ state: undefined, city: undefined }));
    check("no area → 422", noArea.status === 422 && (await err(noArea)) === "service_needs_area");

    // ── Filters ───────────────────────────────────────────────────────────
    console.log("filters");
    const found = await j<{ items: Listing[] }>(await api(`/listings/search?lane=services&serviceType=Plumbing&availability=emergency&state=Lagos&city=Yaba`, null));
    check("serviceType + availability filter finds it", found.items.some((i) => i.id === L.id) && !found.items.some((i) => i.id === allQuote.id));
    const thisWeek = await j<{ items: Listing[] }>(await api(`/listings/search?lane=services&availability=this_week&state=Lagos&city=Yaba`, null));
    check("availability it doesn't have excludes it", !thisWeek.items.some((i) => i.id === L.id));

    // ── Quote-first ───────────────────────────────────────────────────────
    console.log("quote-first");
    const offer = await api(`/listings/${L.id}/offers`, buyer.token, { method: "POST", body: JSON.stringify({ priceKobo: 5_000_00 }) });
    check("buyer offer on a service → 409 quote_first", offer.status === 409 && (await err(offer)) === "quote_first");
    const own = await api(`/listings/${L.id}/quote-requests`, pro.token, { method: "POST", body: JSON.stringify({ service: "x", description: "y" }) });
    check("provider requesting own service → 400", own.status === 400);
    const brief = { service: "Full bathroom plumbing", description: "2 sinks + shower re-pipe", state: "Lagos", city: "Yaba", preferred: "Sat AM" };
    const rq = await api(`/listings/${L.id}/quote-requests`, buyer.token, { method: "POST", body: JSON.stringify(brief) });
    const R = await j<Req>(rq);
    check("buyer sends a quote request → 201, stage new", rq.status === 201 && R.stage === "new" && R.status === "open", `${rq.status} ${R.stage}`);
    const conv = await j<{ quoteRequest?: Req; lastMessage: unknown }>(await api(`/conversations/${R.conversationId}`, buyer.token));
    check("conversation carries the open request", conv.quoteRequest?.id === R.id);
    const inbox0 = await j<Page>(await api(`/quote-requests`, pro.token));
    check("provider inbox: 1 new", inbox0.counts.new === 1 && inbox0.items[0]?.id === R.id, JSON.stringify(inbox0.counts));
    const proConvs = await j<{ items: { id: string }[] }>(await api(`/conversations`, pro.token));
    check("request alone lifts the thread into the provider's messages", proConvs.items.some((c) => c.id === R.conversationId));
    const outsider = await api(`/quote-requests/${R.id}/quote`, other.token, { method: "POST", body: JSON.stringify({ priceKobo: 1_000_00 }) });
    check("outsider can't quote it → 404", outsider.status === 404);
    const past = await api(`/quote-requests/${R.id}/quote`, pro.token, { method: "POST", body: JSON.stringify({ priceKobo: 1_000_00, startsAt: new Date(Date.now() - 86_400_000).toISOString() }) });
    check("start in the past → 422", past.status === 422);

    // ── The quote ─────────────────────────────────────────────────────────
    console.log("quote → counter → accept");
    const startsAt = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const qr = await api(`/quote-requests/${R.id}/quote`, pro.token, { method: "POST", body: JSON.stringify({ priceKobo: 120_000_00, scope: "Labour + fittings", startsAt }) });
    const Q = await j<Req>(qr);
    check("provider quotes ₦120,000 → 201, stage quoted", qr.status === 201 && Q.stage === "quoted" && Q.dealState === "COUNTERED_BY_SELLER" && Q.quotedKobo === 120_000_00, `${qr.status} ${Q.stage} ${Q.dealState}`);
    const D = await j<Deal>(await api(`/deals/${Q.dealId}`, buyer.token));
    check("deal carries the terms", D.terms?.service === "Full bathroom plumbing" && D.terms?.scope === "Labour + fittings" && D.terms?.startsAt === startsAt, JSON.stringify(D.terms));
    const dl1 = await deadline(Q.dealId!);
    check("a quote waits 48h, not 4h", !!dl1 && dl1.hours > 47 && dl1.hours <= 48, `${dl1?.hours}`);
    const again = await api(`/quote-requests/${R.id}/quote`, pro.token, { method: "POST", body: JSON.stringify({ priceKobo: 110_000_00 }) });
    check("second genesis while live → 409 deal_active", again.status === 409 && (await err(again)) === "deal_active");
    const rq2 = await api(`/listings/${L.id}/quote-requests`, buyer.token, { method: "POST", body: JSON.stringify(brief) });
    check("new brief while a quote is live → 409 quote_live", rq2.status === 409 && (await err(rq2)) === "quote_live");
    const act = (t: string, body: unknown) => api(`/deals/${Q.dealId}/actions`, t, { method: "POST", body: JSON.stringify(body) });
    const ctr = await j<Deal>(await act(buyer.token, { action: "counter", priceKobo: 100_000_00 }));
    check("buyer counters ₦100,000", ctr.state === "COUNTERED_BY_BUYER" && ctr.priceKobo === 100_000_00, ctr.state);
    const acc = await j<Deal>(await act(pro.token, { action: "accept" }));
    check("provider accepts", acc.state === "ACCEPTED", acc.state);
    check("…accepted quote still waits 48h for payment", ((await deadline(Q.dealId!))?.hours ?? 0) > 47);

    // ── Escrow → job done → release ───────────────────────────────────────
    console.log("escrow (async: sweeper → consumer → webhook)");
    const pay = await api(`/deals/${Q.dealId}/pay`, buyer.token, { method: "POST" });
    check("pay → PAYMENT_PENDING", pay.status === 200 && (await j<Deal>(pay)).state === "PAYMENT_PENDING");
    let state = "";
    for (let i = 0; i < 14 && state !== "PAID_IN_ESCROW"; i++) {
      await sleep(10_000);
      state = (await sql<{ state: string }[]>`select state from public.deals where id = ${Q.dealId}`)[0]!.state;
      process.stdout.write(`   t+${(i + 1) * 10}s: ${state}\n`);
    }
    check("funds held → PAID_IN_ESCROW", state === "PAID_IN_ESCROW");
    const stock = (await sql<{ stock: number }[]>`select stock from public.listings where id = ${L.id}`)[0]!.stock;
    check("a booked job doesn't consume the listing's stock", stock === 1, `${stock}`);
    const dl2 = await deadline(Q.dealId!);
    const expectH = 5 * 24 + 72;
    check("hand-off clock runs 72h from the job date (~192h)", !!dl2 && dl2.action === "auto_refund" && Math.abs(dl2.hours - expectH) < 1, `${dl2?.hours?.toFixed(1)}h`);
    const inbox1 = await j<Page>(await api(`/quote-requests?stage=scheduled`, pro.token));
    check("inbox shows it Scheduled", inbox1.items.length === 1 && inbox1.counts.scheduled === 1);
    const done = await api(`/deals/${Q.dealId}/handoff`, pro.token, { method: "POST" });
    check("provider marks the job done → HANDED_OFF", done.status === 200 && (await j<Deal>(done)).state === "HANDED_OFF");
    const rel = await api(`/deals/${Q.dealId}/confirm`, buyer.token, { method: "POST" });
    check("buyer confirms & releases → COMPLETED", rel.status === 200 && (await j<Deal>(rel)).state === "COMPLETED");
    const inbox2 = await j<Page>(await api(`/quote-requests`, pro.token));
    check("inbox: done, nothing open", inbox2.counts.all === 0 && inbox2.items[0]?.stage === "done", JSON.stringify(inbox2.counts));
    const rq3 = await api(`/listings/${L.id}/quote-requests`, buyer.token, { method: "POST", body: JSON.stringify({ ...brief, service: "Leak repair & diagnosis" }) });
    check("after the job, the buyer can request again", rq3.status === 201);

    // ── DB backstop ───────────────────────────────────────────────────────
    console.log("db guard");
    let dbErr = "";
    try {
      await sql.begin(async (t) => {
        const [d] = await t`insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty)
          values (${allQuote.id}, ${buyer.id}, ${pro.id}, 'COUNTERED_BY_SELLER', 100, 1) returning id`;
        await t`insert into public.deal_events (deal_id, seq, actor, action, from_state, to_state)
          values (${d!.id}, 1, 'BUYER', 'quote', null, 'COUNTERED_BY_SELLER')`;
      });
    } catch (e) { dbErr = (e as Error).message; }
    check("DB refuses a quote genesis by the buyer", dbErr.includes("illegal genesis"), dbErr.slice(0, 70));
  } finally {
    const deals = sql`select id from public.deals where seller_id = ${pro.id}`;
    await sql`delete from public.ledger_entries where deal_id in (${deals})`;
    await sql`delete from public.outbox where deal_id in (${deals})`;
    await sql`delete from public.payouts where deal_id in (${deals})`.catch(() => {});
    await sql`delete from public.deals where seller_id = ${pro.id}`;
    await sql`delete from public.listings where seller_id = ${pro.id}`;
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ services lane, quote-first + escrow work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
