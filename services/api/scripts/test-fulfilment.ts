import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo, sellerFeeKobo } from "../src/money/fees.js";
import { settleRefund, settleRelease } from "../src/money/ledger.js";
import { reconcile } from "../src/money/reconcile.js";
import { TRANSITIONS } from "../src/deals/machine.js";
import { EFFECTS } from "../src/deals/effects.js";

/**
 * M5 — fulfilment (hand-off → confirm → release/payout, + auto-release + cancel-refund)
 * at the money command layer against the cloud DB. Drives transitions and simulates
 * the release.settled / refund.settled webhooks via settleRelease/settleRefund.
 * Proves M5's "done": happy path to COMPLETED, ledger balanced with the 2% seller fee
 * netted; the 48h SYSTEM auto-release; and seller cancel → refund from escrow.
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
const check = (label: string, ok: boolean, extra = "") => {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
};
async function newUser(tag: string): Promise<string> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST", headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `Test-${Math.random().toString(36).slice(2)}9!`, email_confirm: true }),
  });
  return ((await cr.json()) as { id: string }).id;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("ful-seller");
  const buyers = [await newUser("ful-b1"), await newUser("ful-b2"), await newUser("ful-b3")];
  const userIds = [seller, ...buyers];

  const acct = (dealId: string, account: string) =>
    sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = ${account}`;
  const groups = (dealId: string) =>
    sql<{ n: number; bad: number }[]>`
      select count(*)::int as n,
             count(*) filter (where s <> 0)::int as bad
      from (select txn_group, sum(amount_kobo) as s from public.ledger_entries where deal_id = ${dealId} group by txn_group) g`;

  // offer → accept → pay → payment_confirmed → PAID_IN_ESCROW
  async function toEscrow(buyer: string, listingId: string, price: number): Promise<string> {
    const g = await createOffer(sql, { listingId, buyerId: buyer, priceKobo: price, qty: 1 });
    if (!g.ok) throw new Error(`offer: ${g.code}`);
    await transition(sql, { dealId: g.deal.id, actor: "SELLER", actorId: seller, action: "accept" });
    await transition(sql, { dealId: g.deal.id, actor: "BUYER", actorId: buyer, action: "pay" });
    const c = await transition(sql, { dealId: g.deal.id, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${g.deal.id}:hold`, providerRef: `mock_hold_${g.deal.id}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
    if (!c.ok || c.deal.state !== "PAID_IN_ESCROW") throw new Error(`escrow: ${JSON.stringify(c)}`);
    return g.deal.id;
  }

  try {
    // Guard (Fable #2): every transition from a FUNDED state into a money-terminal
    // state must have a money EFFECT, or an admin/timer resolution could strand funds.
    const FUNDED = new Set(["PAID_IN_ESCROW", "HANDED_OFF", "DISPUTED"]);
    const TERMINAL = new Set(["COMPLETED", "REFUNDED"]);
    const missing = TRANSITIONS.filter((t) => FUNDED.has(t.from) && TERMINAL.has(t.to) && !EFFECTS[t.action]);
    check("every funded→terminal transition has a money effect", missing.length === 0, missing.map((t) => `${t.from}/${t.action}`).join(", "));

    const P = 20_000_000; // ₦200,000
    const BFEE = buyerFeeKobo(P); // 100,000
    const SFEE = sellerFeeKobo(P); // 400,000
    const PAYOUT = P - SFEE; // 19,600,000
    const [l] = await sql<{ id: string }[]>`
      insert into public.listings (seller_id, category, title, price_kobo, stock)
      values (${seller}, 'phones', 'ful-test', ${P}, 3) returning id`;
    const listingId = l!.id;

    // ── A) happy path: handoff → confirm → release settled → COMPLETED ──────────
    const a = await toEscrow(buyers[0]!, listingId, P);
    const ho = await transition(sql, { dealId: a, actor: "SELLER", actorId: seller, action: "hand_off" });
    check("seller hand_off → HANDED_OFF", ho.ok && ho.deal.state === "HANDED_OFF", (ho as any).deal?.state ?? (ho as any).code);
    const cf = await transition(sql, { dealId: a, actor: "BUYER", actorId: buyers[0]!, action: "confirm_receipt" });
    check("buyer confirm_receipt → COMPLETED", cf.ok && cf.deal.state === "COMPLETED", (cf as any).deal?.state);
    check("confirm enqueued escrow.release", (await sql<{ n: number }[]>`select count(*)::int as n from public.outbox where deal_id = ${a} and topic = 'escrow.release'`)[0]!.n === 1);
    // before settlement: only the hold group is booked
    check("pre-settle: escrow_holding still = principal", Number((await acct(a, "escrow_holding"))[0]!.s) === P);

    await settleRelease(sql, { dealId: a, providerRef: `mock_rel_${a}`, amountKobo: PAYOUT });
    const ga = await groups(a);
    check("post-settle: all ledger groups balanced (hold+release)", ga[0]!.n === 2 && ga[0]!.bad === 0, JSON.stringify(ga[0]));
    check("escrow_holding nets to 0 (released)", Number((await acct(a, "escrow_holding"))[0]!.s) === 0);
    check("seller_payable = principal − 2% fee (residual)", Number((await acct(a, "seller_payable"))[0]!.s) === PAYOUT, `${PAYOUT}`);
    check("wcp_fees = buyer 0.5% + seller 2%", Number((await acct(a, "wcp_fees"))[0]!.s) === BFEE + SFEE, `${BFEE + SFEE}`);
    check("external = -(principal + buyer fee)", Number((await acct(a, "external"))[0]!.s) === -(P + BFEE));

    // idempotent release settle
    await settleRelease(sql, { dealId: a, providerRef: `mock_rel_${a}`, amountKobo: PAYOUT });
    check("release settle idempotent (still 2 groups)", (await groups(a))[0]!.n === 2);

    // ── B) 48h auto-release: SYSTEM auto_release from HANDED_OFF → COMPLETED ─────
    const b = await toEscrow(buyers[1]!, listingId, P);
    await transition(sql, { dealId: b, actor: "SELLER", actorId: seller, action: "hand_off" });
    const ar = await transition(sql, { dealId: b, actor: "SYSTEM", action: "auto_release" });
    check("SYSTEM auto_release → COMPLETED", ar.ok && ar.deal.state === "COMPLETED", (ar as any).deal?.state);
    await settleRelease(sql, { dealId: b, providerRef: `mock_rel_${b}`, amountKobo: PAYOUT });
    check("auto-release: seller_payable = payout", Number((await acct(b, "seller_payable"))[0]!.s) === PAYOUT);
    check("auto-release: escrow_holding nets to 0", Number((await acct(b, "escrow_holding"))[0]!.s) === 0);

    // ── C) seller cancels from escrow → REFUNDED, buyer made whole ──────────────
    const c = await toEscrow(buyers[2]!, listingId, P);
    const cx = await transition(sql, { dealId: c, actor: "SELLER", actorId: seller, action: "cancel_refund" });
    check("seller cancel_refund → REFUNDED", cx.ok && cx.deal.state === "REFUNDED", (cx as any).deal?.state);
    check("cancel enqueued escrow.refund", (await sql<{ n: number }[]>`select count(*)::int as n from public.outbox where deal_id = ${c} and topic = 'escrow.refund'`)[0]!.n === 1);
    await settleRefund(sql, { dealId: c, amountKobo: P + BFEE, providerRef: `mock_ref_${c}` });
    check("refund: escrow_holding nets to 0", Number((await acct(c, "escrow_holding"))[0]!.s) === 0);
    check("refund: external nets to 0 (buyer made whole)", Number((await acct(c, "external"))[0]!.s) === 0);
    check("refund: wcp_fees nets to 0 (fee reversed)", Number((await acct(c, "wcp_fees"))[0]!.s) === 0);

    // stock: A + B released (2 sold), C refunded → started 3, decremented on payment
    // for A, B, C = 3, refund does NOT restock in M5 → stock 0.
    const [stock] = await sql<{ stock: number }[]>`select stock from public.listings where id = ${listingId}`;
    check("stock decremented per payment (3 → 0)", stock!.stock === 0, `${stock!.stock}`);

    // ── D) reconciliation: clean now; injected balanced-but-wrong group is caught ─
    const r1 = await reconcile(sql);
    const mine = r1.driftDeals.filter((x) => [a, b, c].includes(x.dealId));
    check("reconcile: no drift on our settled deals", mine.length === 0, JSON.stringify(mine));
    // Inject a BALANCED group (sum 0 → passes the balance trigger) that nudges deal
    // A's escrow_holding to a wrong value (escrow ∉ {0, principal} → drift).
    const grp = (await sql<{ g: string }[]>`select gen_random_uuid() as g`)[0]!.g;
    await sql`
      insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref)
      values (${grp}, ${a}, 'escrow_holding', 500, 'hold', 'drift-probe'),
             (${grp}, ${a}, 'external', -500, 'hold', 'drift-probe')`;
    const r2 = await reconcile(sql);
    check("reconcile: injected drift on deal A is caught", r2.driftDeals.some((x) => x.dealId === a), JSON.stringify(r2.driftDeals.filter((x) => x.dealId === a)));

    // ── E) settlement-lag (Fable #1): a TERMINAL deal with funds still in escrow past
    // the grace window is flagged overdue — the stuck-payout blind spot invariant 2 misses.
    // Insert a synthetic COMPLETED deal (backdated updated_at; the touch trigger is
    // UPDATE-only, so an INSERT keeps our timestamp) with an unsettled hold.
    const [sd] = await sql<{ id: string }[]>`
      insert into public.deals (listing_id, buyer_id, seller_id, state, price_kobo, updated_at)
      values (${listingId}, ${buyers[0]!}, ${seller}, 'COMPLETED', ${P}, now() - interval '30 minutes')
      returning id`;
    const lg = (await sql<{ g: string }[]>`select gen_random_uuid() as g`)[0]!.g;
    await sql`
      insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref)
      values (${lg}, ${sd!.id}, 'escrow_holding', ${P}, 'hold', 'lag-probe'),
             (${lg}, ${sd!.id}, 'external', ${-P}, 'hold', 'lag-probe')`;
    const r3 = await reconcile(sql);
    check("reconcile: overdue terminal deal flagged (escrow ∈ {0,P}, not drift)", r3.settlementOverdue.some((x) => x.dealId === sd!.id) && !r3.driftDeals.some((x) => x.dealId === sd!.id), JSON.stringify(r3.settlementOverdue.filter((x) => x.dealId === sd!.id)));

    // ── F) fail-loud settlement (Fable #3): settling on a non-terminal deal is refused.
    const g2 = await createOffer(sql, { listingId, buyerId: buyers[1]!, priceKobo: P, qty: 1 });
    // dealB (buyers[1]) is already COMPLETED from part B, so this reuses buyers[1] on a
    // fresh offer that's still OFFERED (non-terminal) — releasing on it must be refused.
    if (g2.ok) {
      const bad = await settleRelease(sql, { dealId: g2.deal.id, providerRef: "bad", amountKobo: P });
      check("settleRelease on non-COMPLETED deal is refused", !bad.ok && bad.reason.startsWith("not_completed"), JSON.stringify(bad));
    }
  } finally {
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of userIds) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M5 fulfilment + release ledger + auto-release + cancel-refund correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
