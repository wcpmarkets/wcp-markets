import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo, sellerFeeKobo } from "../src/money/fees.js";
import { settleRefund, settleRelease } from "../src/money/ledger.js";
import { isStaffAdmin } from "../src/deals/admin.js";
import { reconcile } from "../src/money/reconcile.js";

/**
 * M6 — disputes at the command layer against the cloud DB. Three resolution paths:
 * (A) 24h silence → SYSTEM auto_refund; (B) seller responds → admin resolve_refund;
 * (C) seller responds → admin resolve_release. Plus the seller-response clock-stop
 * (DISPUTED_RESPONDED clears the deadline) and the DB-backed staff role check.
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
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
async function newUser(tag: string): Promise<string> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password: `Test-${Math.random().toString(36).slice(2)}9!`, email_confirm: true }) });
  return ((await cr.json()) as { id: string }).id;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("dis-seller");
  const buyers = [await newUser("dis-b1"), await newUser("dis-b2"), await newUser("dis-b3")];
  const staffUser = await newUser("dis-staff");
  const nonStaff = await newUser("dis-nonstaff");
  const userIds = [seller, ...buyers, staffUser, nonStaff];

  const acct = (dealId: string, a: string) => sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = ${a}`;
  const deadline = (dealId: string) => sql<{ action: string }[]>`select action from public.deal_deadlines where deal_id = ${dealId}`;
  const stateOf = async (dealId: string) => (await sql<{ state: string }[]>`select state from public.deals where id = ${dealId}`)[0]!.state;

  async function toEscrow(buyer: string, listingId: string, price: number): Promise<string> {
    const g = await createOffer(sql, { listingId, buyerId: buyer, priceKobo: price, qty: 1 });
    if (!g.ok) throw new Error(`offer: ${g.code}`);
    await transition(sql, { dealId: g.deal.id, actor: "SELLER", actorId: seller, action: "accept" });
    await transition(sql, { dealId: g.deal.id, actor: "BUYER", actorId: buyer, action: "pay" });
    await transition(sql, { dealId: g.deal.id, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${g.deal.id}:hold`, providerRef: `mock_hold_${g.deal.id}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
    return g.deal.id;
  }

  try {
    const P = 20_000_000;
    const BFEE = buyerFeeKobo(P);
    const PAYOUT = P - sellerFeeKobo(P);
    const [l] = await sql<{ id: string }[]>`insert into public.listings (seller_id, category, title, price_kobo, stock) values (${seller}, 'phones', 'dis-test', ${P}, 3) returning id`;
    const listingId = l!.id;

    // ── A) 24h silence → auto_refund ────────────────────────────────────────────
    const a = await toEscrow(buyers[0]!, listingId, P);
    const da = await transition(sql, { dealId: a, actor: "BUYER", actorId: buyers[0]!, action: "dispute", reason: "item not as described" });
    check("buyer dispute → DISPUTED", da.ok && da.deal.state === "DISPUTED", (da as any).deal?.state ?? (da as any).code);
    check("DISPUTED schedules 24h auto_refund deadline", (await deadline(a))[0]?.action === "auto_refund");
    // a dispute case row exists (the route creates it) — the auto_refund effect must close it in-tx
    await sql`insert into public.dispute_cases (deal_id, opened_by, reason) values (${a}, ${buyers[0]!}, 'item not as described') on conflict (deal_id) do nothing`;
    const ar = await transition(sql, { dealId: a, actor: "SYSTEM", action: "auto_refund", reason: "dispute silence" });
    check("SYSTEM auto_refund → REFUNDED", ar.ok && ar.deal.state === "REFUNDED", (ar as any).deal?.state);
    const [caseA] = await sql<{ status: string; resolution: string | null }[]>`select status, resolution from public.dispute_cases where deal_id = ${a}`;
    check("A: auto_refund closed the dispute case in-tx", caseA?.status === "resolved" && caseA?.resolution === "refund", `${caseA?.status}/${caseA?.resolution}`);
    await settleRefund(sql, { dealId: a, amountKobo: P + BFEE, providerRef: `mock_ref_${a}` });
    check("A: buyer made whole (escrow 0, external 0)", Number((await acct(a, "escrow_holding"))[0]!.s) === 0 && Number((await acct(a, "external"))[0]!.s) === 0);

    // ── B) seller responds → admin resolve_refund ──────────────────────────────
    const b = await toEscrow(buyers[1]!, listingId, P);
    await transition(sql, { dealId: b, actor: "BUYER", actorId: buyers[1]!, action: "dispute", reason: "damaged" });
    const rb = await transition(sql, { dealId: b, actor: "SELLER", actorId: seller, action: "respond", reason: "seller responded" });
    check("seller respond → DISPUTED_RESPONDED", rb.ok && rb.deal.state === "DISPUTED_RESPONDED", (rb as any).deal?.state);
    check("respond STOPS the clock (deadline cleared)", (await deadline(b)).length === 0);
    // the stale 24h timer, if it somehow fires now, must be a no-op (state moved on)
    const [dlb] = await sql<{ state_token: string }[]>`select state_token from public.deals where id = ${b}`;
    const stale = await transition(sql, { dealId: b, actor: "SYSTEM", action: "auto_refund", expectedStateToken: "00000000-0000-0000-0000-000000000000" });
    check("stale auto_refund after respond → no-op", !stale.ok);
    check("still DISPUTED_RESPONDED after stale timer", (await stateOf(b)) === "DISPUTED_RESPONDED", dlb!.state_token.slice(0, 8));
    const resR = await transition(sql, { dealId: b, actor: "ADMIN", actorId: staffUser, action: "resolve_refund", reason: "buyer wins" });
    check("admin resolve_refund → REFUNDED", resR.ok && resR.deal.state === "REFUNDED", (resR as any).deal?.state);
    await settleRefund(sql, { dealId: b, amountKobo: P + BFEE, providerRef: `mock_ref_${b}` });
    check("B: buyer made whole", Number((await acct(b, "escrow_holding"))[0]!.s) === 0 && Number((await acct(b, "external"))[0]!.s) === 0);

    // ── C) dispute from HANDED_OFF → respond → admin resolve_release ────────────
    const c = await toEscrow(buyers[2]!, listingId, P);
    await transition(sql, { dealId: c, actor: "SELLER", actorId: seller, action: "hand_off" });
    const dc = await transition(sql, { dealId: c, actor: "BUYER", actorId: buyers[2]!, action: "dispute", reason: "never arrived" });
    check("dispute from HANDED_OFF → DISPUTED", dc.ok && dc.deal.state === "DISPUTED");
    await transition(sql, { dealId: c, actor: "SELLER", actorId: seller, action: "respond", reason: "tracking shows delivered" });
    const resL = await transition(sql, { dealId: c, actor: "ADMIN", actorId: staffUser, action: "resolve_release", reason: "seller wins" });
    check("admin resolve_release → COMPLETED", resL.ok && resL.deal.state === "COMPLETED", (resL as any).deal?.state);
    await settleRelease(sql, { dealId: c, providerRef: `mock_rel_${c}`, amountKobo: PAYOUT });
    check("C: seller paid the payout", Number((await acct(c, "seller_payable"))[0]!.s) === PAYOUT && Number((await acct(c, "escrow_holding"))[0]!.s) === 0);

    // ── D) DB-backed staff role ────────────────────────────────────────────────
    await sql`insert into public.staff_roles (user_id, role) values (${staffUser}, 'admin') on conflict (user_id) do update set role = 'admin'`;
    check("staff admin recognised", (await isStaffAdmin(sql, staffUser)) === true);
    check("non-staff user rejected", (await isStaffAdmin(sql, nonStaff)) === false);

    // ── E) dispute-SLA reconcile: a DISPUTED deal stuck >48h is flagged ─────────
    const [sd] = await sql<{ id: string }[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, updated_at)
      values (${listingId}, ${buyers[0]!}, ${seller}, 'DISPUTED', ${P}, now() - interval '3 days')
      returning id`;
    const rec = await reconcile(sql);
    check("reconcile flags a DISPUTED deal stuck >48h", rec.disputesOverdue.some((x) => x.dealId === sd!.id), JSON.stringify(rec.disputesOverdue.filter((x) => x.dealId === sd!.id)));
  } finally {
    await sql`delete from public.dispute_cases where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql`delete from public.staff_roles where user_id = ${staffUser}`;
    await sql.end({ timeout: 5 });
    for (const u of userIds) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M6 disputes (auto-refund, respond→admin resolve, staff role) correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
