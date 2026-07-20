import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo } from "../src/money/fees.js";

/**
 * M7 — escrow-gated reviews. The guarantee is DB-enforced, so the important tests
 * bypass the app and insert directly: the database itself must reject a review on a
 * non-COMPLETED deal, or by a non-buyer, and must derive seller_id (not trust it).
 * Plus immutability + the seller's one-time reply.
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
async function rejects(fn: () => Promise<unknown>): Promise<boolean> {
  try { await fn(); return false; } catch { return true; }
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("rev-seller");
  const buyer = await newUser("rev-buyer");
  const other = await newUser("rev-other");
  const userIds = [seller, buyer, other];

  async function makeDeal(b: string, listingId: string, price: number, complete: boolean): Promise<string> {
    const g = await createOffer(sql, { listingId, buyerId: b, priceKobo: price, qty: 1 });
    if (!g.ok) throw new Error(`offer: ${g.code}`);
    await transition(sql, { dealId: g.deal.id, actor: "SELLER", actorId: seller, action: "accept" });
    await transition(sql, { dealId: g.deal.id, actor: "BUYER", actorId: b, action: "pay" });
    await transition(sql, { dealId: g.deal.id, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `evt:${g.deal.id}`, providerRef: `mock_hold_${g.deal.id}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
    if (complete) {
      await transition(sql, { dealId: g.deal.id, actor: "SELLER", actorId: seller, action: "hand_off" });
      await transition(sql, { dealId: g.deal.id, actor: "BUYER", actorId: b, action: "confirm_receipt" });
    }
    return g.deal.id;
  }

  try {
    const P = 15_000_000;
    const [l] = await sql<{ id: string }[]>`insert into public.listings (seller_id, category, title, price_kobo, stock) values (${seller}, 'phones', 'rev-test', ${P}, 2) returning id`;
    const listingId = l!.id;
    const completed = await makeDeal(buyer, listingId, P, true);
    const inEscrow = await makeDeal(other, listingId, P, false);

    // ── The gate: DB rejects illegitimate reviews ──────────────────────────────
    check("DB rejects a review on a non-COMPLETED deal",
      await rejects(() => sql`insert into public.reviews (deal_id, reviewer_id, seller_id, rating) values (${inEscrow}, ${other}, ${seller}, 5)`));
    check("DB rejects a review by a non-buyer",
      await rejects(() => sql`insert into public.reviews (deal_id, reviewer_id, seller_id, rating) values (${completed}, ${other}, ${seller}, 5)`));

    // ── Happy: buyer reviews the completed deal; seller_id is DERIVED, not trusted ─
    const [rev] = await sql<{ id: string; seller_id: string }[]>`
      insert into public.reviews (deal_id, reviewer_id, seller_id, rating, body)
      values (${completed}, ${buyer}, ${other}, 5, 'great seller')  -- wrong seller_id on purpose
      returning id, seller_id`;
    check("review accepted on a COMPLETED deal by its buyer", !!rev);
    check("seller_id derived from the deal (spoofed input ignored)", rev!.seller_id === seller, rev!.seller_id.slice(0, 8));

    check("one review per deal (unique deal_id)",
      await rejects(() => sql`insert into public.reviews (deal_id, reviewer_id, seller_id, rating) values (${completed}, ${buyer}, ${seller}, 3)`));

    // ── Immutability ───────────────────────────────────────────────────────────
    check("rating is immutable", await rejects(() => sql`update public.reviews set rating = 1 where deal_id = ${completed}`));
    check("body is immutable", await rejects(() => sql`update public.reviews set body = 'changed' where deal_id = ${completed}`));

    // ── Seller reply (once) ────────────────────────────────────────────────────
    await sql`update public.reviews set seller_reply = 'thank you', replied_at = now() where deal_id = ${completed}`;
    const [ar] = await sql<{ seller_reply: string | null }[]>`select seller_reply from public.reviews where deal_id = ${completed}`;
    check("seller can reply once", ar!.seller_reply === "thank you");
    check("a posted reply cannot be edited", await rejects(() => sql`update public.reviews set seller_reply = 'edited' where deal_id = ${completed}`));

    // ── Hardening (Fable review) ───────────────────────────────────────────────
    check("replied_at can't be back-dated on its own",
      await rejects(() => sql`update public.reviews set replied_at = now() - interval '10 days' where deal_id = ${completed}`));
    check("id is immutable",
      await rejects(() => sql`update public.reviews set id = gen_random_uuid() where deal_id = ${completed}`));
    check("review DELETE is blocked without the erasure GUC",
      await rejects(() => sql`delete from public.reviews where deal_id = ${completed}`));

    // ── Aggregate ──────────────────────────────────────────────────────────────
    const [agg] = await sql<{ n: number; avg: number }[]>`select count(*)::int as n, avg(rating)::float as avg from public.reviews where seller_id = ${seller}`;
    check("seller aggregate: 1 review, avg 5", agg!.n === 1 && agg!.avg === 5, `${agg!.n}/${agg!.avg}`);
  } finally {
    // Deliberate erasure: set the GUC in-tx (the no_delete trigger requires it).
    await sql.begin(async (tx) => {
      await tx`select set_config('wcp.allow_review_erasure', 'on', true)`;
      await tx`delete from public.reviews where seller_id = ${seller}`;
    });
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of userIds) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M7 escrow-gated reviews (DB-enforced) correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
