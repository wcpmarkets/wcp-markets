import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { buyerFeeKobo, sellerFeeKobo } from "../src/money/fees.js";
import { reconcile } from "../src/money/reconcile.js";

/**
 * Phase 3 E live — shortlet bookings on the DEPLOYED API (13g-shortlet, 22a-shortlet,
 * 22a-shortlet-booked, 22a-shortlet-host):
 *   • a shortlet needs a nightly rate and stay rules; bookings are validated
 *     (dates, min nights, guests, own listing) and priced by the server
 *   • instant book → ACCEPTED; the dates are taken at once and never double-book
 *     (API check + the DB exclusion constraint); availability shows them, dates only
 *   • pay → escrow holds stay + deposit; the clock is checkout, not a hand-off SLA
 *   • at checkout the stay releases to the host (fee on the stay only); the deposit
 *     stays held 48h, then goes back to the guest; the booking completes
 *   • a host's deposit claim freezes it for an admin: upheld → the host keeps it;
 *     rejected → it goes back and the booking still COMPLETES
 *   • a problem reported during the stay refunds everything and frees the dates
 *   • ledger + reconciliation hold throughout
 *
 * Time is simulated by pulling the deal's deadline forward; the real sweeper →
 * consumer → webhook path does the rest.
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-shortlets.ts
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
type Deal = { id: string; state: string; priceKobo: number; terms?: { booking?: { nights: number } }; milestones?: Stage[] };
const N = (naira: number) => naira * 100;
/** YYYY-MM-DD, `days` from today (UTC is fine for test dates well in the future). */
const day = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const host = await newUser("sl-h");
  const guest = await newUser("sl-g");
  const guest2 = await newUser("sl-g2");
  const staff = await newUser("sl-a");
  const users = [host, guest, guest2, staff];
  const state = async (id: string) => (await sql<{ state: string }[]>`select state from public.deals where id = ${id}`)[0]!.state;
  // The host is a party to every booking here (each guest only to their own).
  const stages = async (id: string) => (await j<Deal>(await api(`/deals/${id}`, host.token))).milestones ?? [];
  const bal = async (id: string, account: string) =>
    Number((await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${id} and account = ${account}`)[0]!.s);
  const refunded = async (id: string) =>
    Number((await sql<{ s: string }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${id} and movement = 'refund' and account = 'external'`)[0]!.s);
  const until = async (label: string, f: () => Promise<boolean>, tries = 14) => {
    for (let i = 0; i < tries; i++) { if (await f()) return true; await sleep(10_000); process.stdout.write(`   …waiting: ${label} (${(i + 1) * 10}s)\n`); }
    return f();
  };
  /** Make a deal's next deadline due now — the sweeper fires it within a minute. */
  const fastForward = (id: string) => sql`update public.deal_deadlines set due_at = now() where deal_id = ${id}`;
  const deadline = async (id: string) => (await sql<{ action: string; due_at: Date }[]>`select action, due_at from public.deal_deadlines where deal_id = ${id}`)[0];
  try {
    // ── Listing ───────────────────────────────────────────────────────────
    console.log("post a shortlet");
    const base = {
      lane: "property", category: "Shortlets", title: "Serviced 1-bed · VI (test)", description: "Test shortlet.",
      state: "Lagos", city: "Victoria Island",
    };
    const bad = await post("/listings", host.token, { ...base, priceKobo: N(45_000), attributes: { propertyType: "apartment", dealType: "shortlet", beds: 1 } });
    check("shortlet without stay rules → 422", bad.status === 422 && (await err(bad)) === "shortlet_needs_stay_rules");
    const lr = await post("/listings", host.token, {
      ...base, priceKobo: N(45_000),
      attributes: { propertyType: "apartment", dealType: "shortlet", beds: 1, minNights: 2, maxGuests: 3, cleaningKobo: N(10_000), cautionKobo: N(20_000) },
    });
    const L = await j<{ id: string }>(lr);
    check("host lists a shortlet (₦45,000/night, min 2, ₦10k cleaning, ₦20k deposit)", lr.status === 201, `${lr.status}`);

    const offer = await post(`/listings/${L.id}/offers`, guest.token, { priceKobo: N(40_000) });
    check("no offers on a shortlet → 409 book_first", offer.status === 409 && (await err(offer)) === "book_first", `${offer.status}`);

    // ── Booking validation ────────────────────────────────────────────────
    console.log("booking validation");
    const book = (u: U, checkIn: string, checkOut: string, guests = 2) => post(`/listings/${L.id}/bookings`, u.token, { checkIn, checkOut, guests });
    const own = await book(host, day(10), day(13));
    check("host can't book own listing → 400", own.status === 400);
    const short = await book(guest, day(10), day(11));
    check("1 night < min 2 → 422 min_nights", short.status === 422 && (await err(short)) === "min_nights");
    const crowd = await book(guest, day(10), day(13), 5);
    check("5 guests > max 3 → 422", crowd.status === 422 && (await err(crowd)) === "too_many_guests");
    const past = await book(guest, day(-2), day(1));
    check("check-in in the past → 422", past.status === 422 && (await err(past)) === "past_date");
    const backwards = await book(guest, day(13), day(10));
    check("checkout before check-in → 422", backwards.status === 422 && (await err(backwards)) === "invalid_dates");

    // ── Book + pay ────────────────────────────────────────────────────────
    console.log("instant book → pay into escrow");
    const br = await book(guest, day(10), day(13));
    const B = await j<{ dealId: string; conversationId: string }>(br);
    const dealId = B.dealId;
    check("guest books 3 nights → 201 with a thread", br.status === 201 && !!B.conversationId, `${br.status}`);
    const stay = N(45_000) * 3 + N(10_000);
    const deposit = N(20_000);
    const price = stay + deposit;
    let d = await j<Deal>(await api(`/deals/${dealId}`, guest.token));
    check("deal ACCEPTED at ₦165,000 (stay ₦145,000 + deposit ₦20,000)", d.state === "ACCEPTED" && d.priceKobo === price, `${d.state} ${d.priceKobo}`);
    check("…with the stays as proposed stages", d.milestones?.length === 2 && d.milestones[0]!.amountKobo === stay && d.milestones[1]!.amountKobo === deposit);
    const conv = await j<{ listing: { dealType?: string } }>(await api(`/conversations/${B.conversationId}`, guest.token));
    check("the thread knows it's a shortlet", conv.listing?.dealType === "shortlet", JSON.stringify(conv.listing?.dealType));
    const clash = await book(guest2, day(12), day(15));
    check("overlapping dates → 409 dates_unavailable", clash.status === 409 && (await err(clash)) === "dates_unavailable");
    const back2back = await book(guest2, day(13), day(15));
    const B2 = await j<{ dealId: string }>(back2back);
    check("checking in on another guest's checkout day is fine", back2back.status === 201, `${back2back.status}`);
    const av = await j<{ booked: { checkIn: string; checkOut: string }[] }>(await fetch(`${API}/listings/${L.id}/availability`));
    check("availability lists both stays, dates only", av.booked.length === 2 && av.booked[0]!.checkIn === day(10) && !JSON.stringify(av).includes(guest.id), JSON.stringify(av.booked));
    let e0 = "";
    try {
      await sql.begin(async (t) => {
        const [x] = await t`insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, qty)
          values (${L.id}, ${staff.id}, ${host.id}, 'OFFERED', 100000, 1) returning id`;
        await t`insert into public.bookings (deal_id, listing_id, check_in, check_out, guests) values (${x!.id}, ${L.id}, ${day(11)}, ${day(12)}, 1)`;
      });
    } catch (e) { e0 = (e as Error).message; }
    check("DB refuses an overlapping booking even past the API", e0.includes("bookings_no_overlap"), e0.slice(0, 70));

    await post(`/deals/${dealId}/pay`, guest.token);
    check("paid → PAID_IN_ESCROW", await until("escrow", async () => (await state(dealId)) === "PAID_IN_ESCROW"));
    check("escrow holds stay + deposit, buyer fee on the total", (await bal(dealId, "escrow_holding")) === price && (await bal(dealId, "wcp_fees")) === buyerFeeKobo(price));
    const dl = await deadline(dealId);
    check("the escrow clock is checkout (11am Lagos), not a hand-off SLA", dl?.action === "check_out" && dl.due_at.toISOString() === `${day(13)}T10:00:00.000Z`, `${dl?.action} ${dl?.due_at?.toISOString()}`);
    const ho = await post(`/deals/${dealId}/handoff`, host.token);
    check("host can't 'hand off' a stay → 409", ho.status === 409);
    const cf = await post(`/deals/${dealId}/confirm`, guest.token);
    check("guest can't 'confirm receipt' of a stay → 409", cf.status === 409);
    const early = await post(`/deals/${dealId}/claim-deposit`, host.token, { reason: "too early" });
    check("no deposit claim before checkout → 409", early.status === 409);

    // ── Checkout ──────────────────────────────────────────────────────────
    console.log("checkout → stay to the host, deposit held");
    await fastForward(dealId);
    check("checkout fires → HANDED_OFF (checked out)", await until("checkout", async () => (await state(dealId)) === "HANDED_OFF"));
    check("stay settles → released", await until("stay settle", async () => (await stages(dealId))[0]?.status === "released"));
    check("host owed the stay net of 2% — no fee on the deposit", (await bal(dealId, "seller_payable")) === stay - sellerFeeKobo(stay), `${await bal(dealId, "seller_payable")}`);
    check("escrow now holds just the deposit", (await bal(dealId, "escrow_holding")) === deposit);
    const dl2 = await deadline(dealId);
    check("deposit clock: 48h → auto_release (return it)", dl2?.action === "auto_release" && Math.abs(dl2.due_at.getTime() - Date.now() - 48 * 3_600_000) < 10 * 60_000);
    const late = await post(`/deals/${dealId}/dispute`, guest.token, { reason: "after the fact" });
    check("guest can't dispute a stay already checked out → 409", late.status === 409);
    let rec = await reconcile(sql);
    check("reconcile: a checked-out booking holding its deposit is not drift", !rec.driftDeals.some((x) => x.dealId === dealId) && rec.globalBalanceKobo === 0);

    // ── Payout mid-booking ────────────────────────────────────────────────
    const kv = await post("/kyc/verify", host.token, { idType: "bvn", idNumber: "22345678901" });
    check("host verifies (L2)", kv.status === 200, `${kv.status}`);
    const po = await post(`/deals/${dealId}/payout`, host.token);
    check("host withdraws the stay while the deposit is held → 201", po.status === 201, `${po.status}`);
    check("payout settles", await until("payout", async () => (await sql<{ status: string }[]>`select status from public.payouts where deal_id = ${dealId}`)[0]?.status === "settled"));

    // ── Deposit returns ───────────────────────────────────────────────────
    console.log("48h later, no claim → deposit back to the guest");
    await fastForward(dealId);
    check("auto_release → COMPLETED", await until("complete", async () => (await state(dealId)) === "COMPLETED"));
    check("deposit settles → refunded", await until("deposit back", async () => (await stages(dealId))[1]?.status === "refunded"));
    check("guest got back exactly the deposit (no fee)", (await refunded(dealId)) === deposit, `${await refunded(dealId)}`);
    check("escrow empty; WCP kept buyer fee + seller fee on the stay", (await bal(dealId, "escrow_holding")) === 0 && (await bal(dealId, "wcp_fees")) === buyerFeeKobo(price) + sellerFeeKobo(stay), `${await bal(dealId, "wcp_fees")}`);
    const rv = await post(`/deals/${dealId}/review`, guest.token, { rating: 5, body: "Lovely stay" });
    check("guest can review the completed stay", rv.status === 201, `${rv.status}`);

    // ── Second booking: deposit claim, rejected ───────────────────────────
    console.log("deposit claim → admin rejects → deposit back, booking COMPLETED");
    await post(`/deals/${B2.dealId}/pay`, guest2.token);
    check("guest 2 paid", await until("escrow 2", async () => (await state(B2.dealId)) === "PAID_IN_ESCROW"));
    await fastForward(B2.dealId);
    check("guest 2 checks out", await until("checkout 2", async () => (await state(B2.dealId)) === "HANDED_OFF"));
    const cl = await post(`/deals/${B2.dealId}/claim-deposit`, host.token, { reason: "Broken TV", evidence: "photo" });
    check("host claims the deposit → DISPUTED_RESPONDED (awaiting admin)", cl.status === 200 && (await state(B2.dealId)) === "DISPUTED_RESPONDED", `${cl.status}`);
    check("no clock while an admin decides", !(await deadline(B2.dealId)));
    await sql`insert into public.staff_roles (user_id, role) values (${staff.id}, 'admin') on conflict (user_id) do update set role = 'admin'`;
    const rj = await post(`/deals/${B2.dealId}/dispute/resolve`, staff.token, { resolution: "refund", note: "no evidence" });
    check("admin rejects the claim → COMPLETED (not REFUNDED: the stay happened)", rj.status === 200 && (await state(B2.dealId)) === "COMPLETED", `${rj.status} ${await state(B2.dealId)}`);
    check("deposit goes back to guest 2", await until("deposit 2", async () => (await stages(B2.dealId))[1]?.status === "refunded"));
    check("host keeps the stay", (await stages(B2.dealId))[0]?.status === "released" && (await refunded(B2.dealId)) === deposit);
    const freed = (await sql<{ active: boolean }[]>`select active from public.bookings where deal_id = ${B2.dealId}`)[0];
    check("a completed stay keeps its dates", freed?.active === true);

    // ── Third booking: deposit claim, upheld ──────────────────────────────
    console.log("deposit claim → admin upholds → the host keeps it");
    const b3 = await j<{ dealId: string }>(await book(guest, day(20), day(22)));
    await post(`/deals/${b3.dealId}/pay`, guest.token);
    check("booking 3 paid", await until("escrow 3", async () => (await state(b3.dealId)) === "PAID_IN_ESCROW"));
    await fastForward(b3.dealId);
    check("booking 3 checks out", await until("checkout 3", async () => (await state(b3.dealId)) === "HANDED_OFF"));
    await post(`/deals/${b3.dealId}/claim-deposit`, host.token, { reason: "Stained mattress" });
    const up = await post(`/deals/${b3.dealId}/dispute/resolve`, staff.token, { resolution: "release", note: "photos convincing" });
    check("admin upholds → COMPLETED", up.status === 200 && (await state(b3.dealId)) === "COMPLETED");
    check("deposit released to the host", await until("deposit 3", async () => (await stages(b3.dealId))[1]?.status === "released"));
    const stay3 = N(45_000) * 2 + N(10_000);
    check("host owed stay − 2% + the whole deposit (no fee on it)", (await bal(b3.dealId, "seller_payable")) === stay3 - sellerFeeKobo(stay3) + deposit, `${await bal(b3.dealId, "seller_payable")}`);
    check("guest got nothing back", (await refunded(b3.dealId)) === 0);

    // ── Fourth booking: problem during the stay → full refund ─────────────
    console.log("problem during the stay → host silent 24h → full refund, dates freed");
    const b4 = await j<{ dealId: string }>(await book(guest, day(25), day(27)));
    await post(`/deals/${b4.dealId}/pay`, guest.token);
    check("booking 4 paid", await until("escrow 4", async () => (await state(b4.dealId)) === "PAID_IN_ESCROW"));
    const dp = await post(`/deals/${b4.dealId}/dispute`, guest.token, { reason: "No water, no power", evidence: "photos" });
    check("guest reports a problem → DISPUTED (funds frozen)", dp.status === 201 && (await state(b4.dealId)) === "DISPUTED");
    await fastForward(b4.dealId);
    check("host silent → auto refund → REFUNDED", await until("refund 4", async () => (await state(b4.dealId)) === "REFUNDED"));
    const price4 = N(45_000) * 2 + N(10_000) + deposit;
    check("guest made whole: stay + deposit + fee", await until("refund settle 4", async () => (await refunded(b4.dealId)) === price4 + buyerFeeKobo(price4)), `${await refunded(b4.dealId)}`);
    const f4 = (await sql<{ active: boolean }[]>`select active from public.bookings where deal_id = ${b4.dealId}`)[0];
    check("refunded booking frees its dates", f4?.active === false);
    const rebook = await book(guest2, day(25), day(27));
    check("…and they can be booked again", rebook.status === 201, `${rebook.status}`);

    rec = await reconcile(sql);
    const ids = [dealId, B2.dealId, b3.dealId, b4.dealId];
    check("reconcile clean for every booking", !ids.some((id) => rec.driftDeals.some((x) => x.dealId === id) || rec.settlementOverdue.some((x) => x.dealId === id) || rec.stagesOverdue.some((s) => s.dealId === id)) && rec.globalBalanceKobo === 0);
  } finally {
    const deals = sql`select id from public.deals where seller_id = ${host.id}`;
    await sql.begin(async (tx) => {
      await tx`select set_config('wcp.allow_review_erasure', 'on', true)`;
      await tx`delete from public.reviews where seller_id = ${host.id}`;
    });
    await sql`delete from public.dispute_cases where deal_id in (${deals})`.catch(() => {});
    await sql`delete from public.ledger_entries where deal_id in (${deals})`;
    await sql`delete from public.outbox where deal_id in (${deals})`;
    await sql`delete from public.payouts where deal_id in (${deals})`;
    await sql`delete from public.deal_milestones where deal_id in (${deals})`;
    await sql`delete from public.bookings where deal_id in (${deals})`;
    await sql`delete from public.deals where seller_id = ${host.id}`;
    await sql`delete from public.listings where seller_id = ${host.id}`;
    await sql`delete from public.kyc_verifications where user_id = ${host.id}`.catch(() => {});
    await sql`delete from public.staff_roles where user_id = ${staff.id}`.catch(() => {});
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ shortlet bookings work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
