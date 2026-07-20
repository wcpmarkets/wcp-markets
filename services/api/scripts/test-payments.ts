import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo } from "../src/money/fees.js";

/**
 * M4 sub-step 1 — the money command layer against the cloud DB (no AWS): the
 * payment sub-machine + double-entry ledger + fees + the oversold race, driven
 * through commands.transition() (a webhook consumer will drive payment_confirmed in
 * sub-step 2). Proves M4's "done": pay → confirm → PAID_IN_ESCROW, ledger balanced
 * incl. fee, and stock decremented exactly once under a double-pay (oversold) race.
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
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `Test-${Math.random().toString(36).slice(2)}9!`, email_confirm: true }),
  });
  return ((await cr.json()) as { id: string }).id;
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("pay-seller");
  const buyer1 = await newUser("pay-b1");
  const buyer2 = await newUser("pay-b2");
  const userIds = [seller, buyer1, buyer2];

  // Drive offer→accept→pay for a buyer; return the deal id.
  async function toPaymentPending(buyer: string, listingId: string, price: number): Promise<string> {
    const g = await createOffer(sql, { listingId, buyerId: buyer, priceKobo: price, qty: 1 });
    if (!g.ok) throw new Error(`offer failed: ${g.code}`);
    await transition(sql, { dealId: g.deal.id, actor: "SELLER", actorId: seller, action: "accept" });
    const pr = await transition(sql, { dealId: g.deal.id, actor: "BUYER", actorId: buyer, action: "pay" });
    if (!pr.ok || pr.deal.state !== "PAYMENT_PENDING") throw new Error(`pay failed: ${JSON.stringify(pr)}`);
    return g.deal.id;
  }
  const groupSums = (dealId: string) =>
    sql<{ txn_group: string; s: number }[]>`
      select txn_group, sum(amount_kobo)::bigint as s from public.ledger_entries
      where deal_id = ${dealId} group by txn_group
    `;
  const acct = (dealId: string, account: string) =>
    sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = ${account}`;

  try {
    const P = 20_000_000; // ₦200,000
    const FEE = buyerFeeKobo(P); // 0.5% → ₦1,000 (100,000 kobo)
    const [l] = await sql<{ id: string }[]>`
      insert into public.listings (seller_id, category, title, price_kobo, stock)
      values (${seller}, 'phones', 'pay-test', ${P}, 1) returning id
    `;
    const listingId = l!.id;

    // ── A) happy path: pay → confirm → PAID_IN_ESCROW, balanced ledger + fee ────
    const dealA = await toPaymentPending(buyer1, listingId, P);
    // escrow.create_hold enqueued on pay?
    const holdMsg = await sql<{ n: number }[]>`select count(*)::int as n from public.outbox where deal_id = ${dealA} and topic = 'escrow.create_hold'`;
    check("pay enqueued escrow.create_hold", (holdMsg[0]?.n ?? 0) === 1);

    const confA = await transition(sql, { dealId: dealA, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${dealA}:1` });
    check("confirm → PAID_IN_ESCROW", confA.ok && confA.deal.state === "PAID_IN_ESCROW", (confA as any).deal?.state ?? (confA as any).code);
    const sumsA = await groupSums(dealA);
    check("ledger: hold group balances to 0", sumsA.length === 1 && Number(sumsA[0]!.s) === 0, JSON.stringify(sumsA));
    check("ledger: escrow_holding = principal", Number((await acct(dealA, "escrow_holding"))[0]!.s) === P);
    check("ledger: wcp_fees = buyer fee", Number((await acct(dealA, "wcp_fees"))[0]!.s) === FEE, `${FEE}`);
    check("ledger: external = -(principal+fee)", Number((await acct(dealA, "external"))[0]!.s) === -(P + FEE));
    const [stockA] = await sql<{ stock: number }[]>`select stock from public.listings where id = ${listingId}`;
    check("stock decremented 1 → 0", stockA!.stock === 0, `${stockA!.stock}`);

    // ── B) idempotent confirm: same provider event id → no double-book ──────────
    const confA2 = await transition(sql, { dealId: dealA, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${dealA}:1` });
    check("re-confirm same event id → replay", confA2.ok && (confA2 as any).replay === true);
    const entriesA = await sql<{ n: number }[]>`select count(*)::int as n from public.ledger_entries where deal_id = ${dealA}`;
    check("re-confirm wrote NO extra ledger rows (still 3)", entriesA[0]!.n === 3, `${entriesA[0]!.n}`);

    // ── C) oversold race: buyer2 paid too; confirm after stock gone → REFUNDED ──
    const dealB = await toPaymentPending(buyer2, listingId, P); // stock already 0
    const confB = await transition(sql, { dealId: dealB, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${dealB}:1` });
    check("oversold confirm → REFUNDED (redirect)", confB.ok && confB.deal.state === "REFUNDED", (confB as any).deal?.state);
    const [evB] = await sql<{ action: string; requested_action: string }[]>`
      select action, requested_action from public.deal_events where deal_id = ${dealB} order by seq desc limit 1
    `;
    check("event action=oversold, requested_action=payment_confirmed", evB!.action === "oversold" && evB!.requested_action === "payment_confirmed", `${evB!.action}/${evB!.requested_action}`);
    const sumsB = await groupSums(dealB);
    check("ledger: both groups (hold+refund) balance to 0", sumsB.length === 2 && sumsB.every((g) => Number(g.s) === 0), JSON.stringify(sumsB));
    check("ledger: escrow_holding nets to 0 (hold+refund)", Number((await acct(dealB, "escrow_holding"))[0]!.s) === 0);
    check("ledger: external nets to 0 (buyer made whole)", Number((await acct(dealB, "external"))[0]!.s) === 0);
    check("oversold enqueued escrow.refund", (await sql<{ n: number }[]>`select count(*)::int as n from public.outbox where deal_id = ${dealB} and topic = 'escrow.refund'`)[0]!.n === 1);
    const [stockB] = await sql<{ stock: number }[]>`select stock from public.listings where id = ${listingId}`;
    check("stock still 0 (decremented exactly once across both pays)", stockB!.stock === 0, `${stockB!.stock}`);

    // ── D) the balance trigger actually rejects an unbalanced group ─────────────
    let rejected = false;
    try {
      await sql.begin(async (tx) => {
        await tx`insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref)
                 values (gen_random_uuid(), ${dealA}, 'escrow_holding', 123, 'hold', 'bad-test')`;
      });
    } catch {
      rejected = true;
    }
    check("unbalanced ledger group is rejected at commit", rejected);
  } finally {
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of userIds) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M4 payment sub-machine + ledger + oversold correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
