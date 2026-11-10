import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { buyerFeeKobo, sellerFeeKobo, stageSellerFees } from "../src/money/fees.js";
import { reconcile } from "../src/money/reconcile.js";

/**
 * Phase 3 D-2 live — milestone escrow on the DEPLOYED API (22c-quotebuild,
 * 22c-quotecard-staged, 22c-milestone):
 *   • staged quotes are validated (2–6 stages, ≥₦1,000 each, summing to the price)
 *   • a buyer's counter rescales the stages; only the provider re-splits
 *   • funding materialises the stages; each stage is marked done → confirmed → released
 *     on its own, through the real async sweeper → consumer → webhook path
 *   • the provider withdraws released stages mid-job, in parts
 *   • the ledger, fees and reconciliation hold at every step
 *   • a dispute after a stage released refunds only what's still held (no fee back)
 *   • the DB refuses stages that don't sum to the price, and money moving backwards
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-milestones.ts
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
const api = (path: string, t: string, init: RequestInit = {}) => fetch(`${API}${path}`, { ...init, headers: H(t) });
const post = (path: string, t: string, body?: unknown) => api(path, t, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const err = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "";

type Stage = { idx: number; title: string; amountKobo: number; status: string };
type Deal = { id: string; state: string; priceKobo: number; terms?: { milestones?: { title: string; amountKobo: number }[] }; milestones?: Stage[] };
type Req = { id: string; dealId: string | null };
const N = (naira: number) => naira * 100;

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const pro = await newUser("ms-p");
  const buyer = await newUser("ms-b");
  const staff = await newUser("ms-a");
  const users = [pro, buyer, staff];
  const state = async (id: string) => (await sql<{ state: string }[]>`select state from public.deals where id = ${id}`)[0]!.state;
  const stages = async (id: string) => (await j<Deal>(await api(`/deals/${id}`, buyer.token))).milestones ?? [];
  const bal = async (id: string, account: string) =>
    Number((await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${id} and account = ${account}`)[0]!.s);
  const until = async (label: string, f: () => Promise<boolean>, tries = 14) => {
    for (let i = 0; i < tries; i++) { if (await f()) return true; await sleep(10_000); process.stdout.write(`   …waiting: ${label} (${(i + 1) * 10}s)\n`); }
    return f();
  };
  try {
    const lr = await post("/listings", pro.token, {
      lane: "services", category: "Repair & Construction", title: "Staged plumbing test", description: "Big jobs, staged.",
      priceKobo: 0, state: "Lagos", city: "Yaba",
      attributes: { serviceType: "Plumbing", rateCard: [{ name: "Full bathroom plumbing" }], coverageKm: 5 },
    });
    const L = await j<{ id: string }>(lr);
    check("provider posts a service", lr.status === 201, `${lr.status}`);
    const brief = { service: "Full bathroom plumbing", description: "2 sinks + shower re-pipe", state: "Lagos", city: "Yaba" };
    const R = await j<Req>(await post(`/listings/${L.id}/quote-requests`, buyer.token, brief));

    // ── Validation ────────────────────────────────────────────────────────
    console.log("staged quote validation");
    const q = (body: unknown) => post(`/quote-requests/${R.id}/quote`, pro.token, body);
    const one = await q({ priceKobo: N(120_000), milestones: [{ title: "All", amountKobo: N(120_000) }] });
    check("one stage → 422 too_few_stages", one.status === 422 && (await err(one)) === "too_few_stages");
    const off = await q({ priceKobo: N(120_000), milestones: [{ title: "A", amountKobo: N(40_000) }, { title: "B", amountKobo: N(40_000) }] });
    check("stages not summing to the price → 422", off.status === 422 && (await err(off)) === "stages_must_sum_to_price");
    const tiny = await q({ priceKobo: N(120_500), milestones: [{ title: "A", amountKobo: N(120_000) }, { title: "B", amountKobo: N(500) }] });
    check("a stage under ₦1,000 → 422", tiny.status === 422 && (await err(tiny)) === "stage_too_small");

    // ── Quote → counters ──────────────────────────────────────────────────
    console.log("quote → counters");
    const plan = [
      { title: "Materials & start", amountKobo: N(40_000) },
      { title: "Pipes & fittings in", amountKobo: N(45_000) },
      { title: "Test & finish", amountKobo: N(35_000) },
    ];
    const startsAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const qr = await q({ priceKobo: N(120_000), scope: "Labour + fittings", startsAt, milestones: plan });
    const Q = await j<Req>(qr);
    const dealId = Q.dealId!;
    check("staged quote → 201", qr.status === 201, `${qr.status}`);
    let st = await stages(dealId);
    check("deal shows 3 proposed stages", st.length === 3 && st.every((s) => s.status === "proposed") && st[1]!.amountKobo === N(45_000), JSON.stringify(st.map((s) => s.status)));
    const act = (t: string, body: unknown) => post(`/deals/${dealId}/actions`, t, body);
    const bsplit = await act(buyer.token, { action: "counter", priceKobo: N(100_000), milestones: plan });
    check("buyer can't re-split → 400", bsplit.status === 400 && (await err(bsplit)) === "only_provider_counter_stages");
    const bc = await j<Deal>(await act(buyer.token, { action: "counter", priceKobo: N(100_000) }));
    const scaled = bc.milestones ?? [];
    check("buyer counter ₦100,000 rescales the stages", bc.state === "COUNTERED_BY_BUYER" && scaled.reduce((a, s) => a + s.amountKobo, 0) === N(100_000) && scaled.length === 3,
      scaled.map((s) => s.amountKobo / 100).join("/"));
    const low = await act(pro.token, { action: "counter", priceKobo: N(1_500) });
    check("counter too low to keep 3 stages → 422", low.status === 422 && (await err(low)) === "price_too_low_for_stages");
    const resplit = [{ title: "First fix", amountKobo: N(50_000) }, { title: "Second fix & test", amountKobo: N(60_000) }];
    const pc = await j<Deal>(await act(pro.token, { action: "counter", priceKobo: N(110_000), milestones: resplit }));
    check("provider counters ₦110,000 as 2 stages", pc.state === "COUNTERED_BY_SELLER" && pc.milestones?.length === 2 && pc.milestones[1]!.amountKobo === N(60_000));
    const acc = await j<Deal>(await act(buyer.token, { action: "accept" }));
    check("buyer accepts", acc.state === "ACCEPTED", acc.state);

    // ── Fund ──────────────────────────────────────────────────────────────
    console.log("fund the whole job (async escrow)");
    const P = N(110_000);
    await post(`/deals/${dealId}/pay`, buyer.token);
    check("funded → PAID_IN_ESCROW", await until("escrow", async () => (await state(dealId)) === "PAID_IN_ESCROW"));
    st = await stages(dealId);
    check("stages materialised, both held", st.length === 2 && st.every((s) => s.status === "held"), JSON.stringify(st.map((s) => s.status)));
    check("escrow holds the full price, buyer fee taken once", (await bal(dealId, "escrow_holding")) === P && (await bal(dealId, "wcp_fees")) === buyerFeeKobo(P));
    const dl = (await sql<{ action: string }[]>`select action from public.deal_deadlines where deal_id = ${dealId}`)[0];
    check("first stage still has the hand-off clock", dl?.action === "auto_refund");

    // ── Stage 1 ───────────────────────────────────────────────────────────
    console.log("stage 1: done → confirm → release");
    const fees = stageSellerFees([N(50_000), N(60_000)]);
    const h1 = await post(`/deals/${dealId}/handoff`, pro.token);
    check("provider marks stage 1 done → HANDED_OFF", h1.status === 200 && (await j<Deal>(h1)).state === "HANDED_OFF");
    const c1 = await post(`/deals/${dealId}/confirm`, buyer.token);
    const c1d = await j<Deal>(c1);
    check("buyer confirms stage 1 → back to PAID_IN_ESCROW (not COMPLETED)", c1.status === 200 && c1d.state === "PAID_IN_ESCROW", c1d.state);
    check("…stage 1 releasing, stage 2 held", c1d.milestones?.[0]?.status === "releasing" && c1d.milestones?.[1]?.status === "held", JSON.stringify(c1d.milestones?.map((s) => s.status)));
    const ev = (await sql<{ action: string; requested_action: string }[]>`select action, requested_action from public.deal_events where deal_id = ${dealId} order by seq desc limit 1`)[0];
    check("event log: confirm_receipt redirected to release_stage", ev?.action === "release_stage" && ev?.requested_action === "confirm_receipt", JSON.stringify(ev));
    const noDl = (await sql`select 1 from public.deal_deadlines where deal_id = ${dealId}`).length === 0;
    check("work in progress: no auto-refund clock after a stage released", noDl);
    check("stage 1 settles → released", await until("stage 1 settle", async () => (await stages(dealId))[0]?.status === "released"));
    check("escrow now holds only stage 2", (await bal(dealId, "escrow_holding")) === N(60_000), `${await bal(dealId, "escrow_holding")}`);
    check("provider is owed stage 1 net of its fee share", (await bal(dealId, "seller_payable")) === N(50_000) - fees[0]!, `${await bal(dealId, "seller_payable")}`);
    let rec = await reconcile(sql);
    check("reconcile: a partly-released job is not drift", !rec.driftDeals.some((d) => d.dealId === dealId) && rec.globalBalanceKobo === 0);

    // ── Mid-job payout ────────────────────────────────────────────────────
    console.log("mid-job payout (L2)");
    const kv = await post("/kyc/verify", pro.token, { idType: "bvn", idNumber: "22345678901" });
    check("provider verifies (L2)", kv.status === 200, `${kv.status}`);
    const po1 = await post(`/deals/${dealId}/payout`, pro.token);
    const po1b = await j<{ amountKobo: number; status: string }>(po1);
    check("withdraw stage 1 mid-job → 201", po1.status === 201 && po1b.amountKobo === N(50_000) - fees[0]!, `${po1.status} ${po1b.amountKobo}`);
    const dup = await post(`/deals/${dealId}/payout`, pro.token);
    check("a second payout while one is in flight → 409", dup.status === 409);
    check("payout part 0 settles", await until("payout 0", async () => (await sql<{ status: string }[]>`select status from public.payouts where deal_id = ${dealId} and part = 0`)[0]?.status === "settled"));
    check("seller_payable back to 0", (await bal(dealId, "seller_payable")) === 0);

    // ── Stage 2 (last) ────────────────────────────────────────────────────
    console.log("stage 2 (last): done → confirm → COMPLETED");
    await post(`/deals/${dealId}/handoff`, pro.token);
    const c2 = await j<Deal>(await post(`/deals/${dealId}/confirm`, buyer.token));
    check("confirming the last stage → COMPLETED", c2.state === "COMPLETED", c2.state);
    check("stage 2 settles → released", await until("stage 2 settle", async () => (await stages(dealId))[1]?.status === "released"));
    check("escrow empty", (await bal(dealId, "escrow_holding")) === 0);
    check("total seller fee = the ordinary fee on ₦110,000", (await bal(dealId, "wcp_fees")) === buyerFeeKobo(P) + sellerFeeKobo(P), `${await bal(dealId, "wcp_fees")}`);
    const po2 = await post(`/deals/${dealId}/payout`, pro.token);
    check("withdraw stage 2 → 201 (part 1)", po2.status === 201 && (await j<{ amountKobo: number }>(po2)).amountKobo === N(60_000) - fees[1]!);
    check("payout part 1 settles", await until("payout 1", async () => (await sql<{ status: string }[]>`select status from public.payouts where deal_id = ${dealId} and part = 1`)[0]?.status === "settled"));
    check("provider paid exactly price − seller fee overall", -(await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and movement = 'payout' and account = 'seller_payable'`)[0]!.s === P - sellerFeeKobo(P));
    const again = await q({ priceKobo: N(10_000) });
    check("the finished request can't be quoted again → 409 request_closed", again.status === 409 && (await err(again)) === "request_closed");

    // ── Dispute mid-job → refund only what's held ─────────────────────────
    console.log("dispute after a stage → refund the rest");
    const R2 = await j<Req>(await post(`/listings/${L.id}/quote-requests`, buyer.token, { ...brief, service: "Kitchen re-pipe" }));
    const q2 = await j<Req>(await post(`/quote-requests/${R2.id}/quote`, pro.token, { priceKobo: N(50_000), milestones: [{ title: "Strip out", amountKobo: N(30_000) }, { title: "Re-pipe", amountKobo: N(20_000) }] }));
    const d2 = q2.dealId!;
    await post(`/deals/${d2}/actions`, buyer.token, { action: "accept" });
    await post(`/deals/${d2}/pay`, buyer.token);
    check("second job funded", await until("escrow 2", async () => (await state(d2)) === "PAID_IN_ESCROW"));
    await post(`/deals/${d2}/handoff`, pro.token);
    await post(`/deals/${d2}/confirm`, buyer.token);
    check("stage 1 of job 2 released", await until("j2 s1", async () => (await stages(d2))[0]?.status === "released"));
    const dr = await post(`/deals/${d2}/dispute`, buyer.token, { reason: "stopped turning up", evidence: "messages" });
    check("buyer disputes mid-job → DISPUTED", dr.status === 201 && (await state(d2)) === "DISPUTED", `${dr.status}`);
    const frozen = await post(`/deals/${d2}/payout`, pro.token);
    check("payout frozen while disputed → 409", frozen.status === 409);
    await sql`insert into public.staff_roles (user_id, role) values (${staff.id}, 'admin') on conflict (user_id) do update set role = 'admin'`;
    const rs = await post(`/deals/${d2}/dispute/resolve`, staff.token, { resolution: "refund", note: "test" });
    check("admin resolves for the buyer → REFUNDED", rs.status === 200 && (await state(d2)) === "REFUNDED", `${rs.status}`);
    check("refund settles: stage 2 refunded", await until("refund", async () => (await stages(d2))[1]?.status === "refunded"));
    const back = Number((await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${d2} and movement = 'refund' and account = 'external'`)[0]!.s);
    check("buyer gets back only the held stage (₦20,000, no fee — work was delivered)", back === N(20_000), `${back}`);
    check("job 2 escrow empty; stage 1 stays the provider's", (await bal(d2, "escrow_holding")) === 0 && (await bal(d2, "seller_payable")) === N(30_000) - stageSellerFees([N(30_000), N(20_000)])[0]!);
    rec = await reconcile(sql);
    check("reconcile clean for both jobs", ![dealId, d2].some((id) => rec.driftDeals.some((d) => d.dealId === id) || rec.settlementOverdue.some((d) => d.dealId === id) || rec.stagesOverdue.some((s) => s.dealId === id)) && rec.globalBalanceKobo === 0);

    // ── DB backstops ──────────────────────────────────────────────────────
    console.log("db guards");
    let e1 = "";
    try { await sql`update public.deal_milestones set status = 'held' where deal_id = ${dealId} and idx = 1`; } catch (e) { e1 = (e as Error).message; }
    check("DB refuses money moving backwards (released → held)", e1.includes("illegal stage move"), e1.slice(0, 60));
    let e2 = "";
    try { await sql`update public.deal_milestones set amount_kobo = 1 where deal_id = ${dealId} and idx = 1`; } catch (e) { e2 = (e as Error).message; }
    check("DB refuses changing a held stage's amount", e2.includes("immutable"), e2.slice(0, 60));
    let e3 = "";
    try {
      await sql.begin(async (t) => {
        const [d] = await t`insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty)
          values (${L.id}, ${staff.id}, ${pro.id}, 'COUNTERED_BY_SELLER', 100000, 1) returning id`;
        await t`insert into public.deal_milestones (deal_id, idx, title, amount_kobo) values (${d!.id}, 1, 'a', 50000), (${d!.id}, 2, 'b', 40000)`;
      });
    } catch (e) { e3 = (e as Error).message; }
    check("DB refuses stages that don't sum to the price", e3.includes("sum to"), e3.slice(0, 60));
  } finally {
    const deals = sql`select id from public.deals where seller_id = ${pro.id}`;
    await sql`delete from public.dispute_cases where deal_id in (${deals})`.catch(() => {});
    await sql`delete from public.ledger_entries where deal_id in (${deals})`;
    await sql`delete from public.outbox where deal_id in (${deals})`;
    await sql`delete from public.payouts where deal_id in (${deals})`;
    await sql`delete from public.deal_milestones where deal_id in (${deals})`;
    await sql`delete from public.deals where seller_id = ${pro.id}`;
    await sql`delete from public.listings where seller_id = ${pro.id}`;
    await sql`delete from public.kyc_verifications where user_id = ${pro.id}`.catch(() => {});
    await sql`delete from public.staff_roles where user_id = ${staff.id}`.catch(() => {});
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ milestone escrow works end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
