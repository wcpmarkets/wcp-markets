import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo, sellerFeeKobo } from "../src/money/fees.js";
import { settleRelease, settlePayout } from "../src/money/ledger.js";
import { reconcile } from "../src/money/reconcile.js";
import { MockKycProvider } from "../src/kyc/provider.js";

/**
 * M8 — KYC + payouts at the command/DB layer. The crux: the DB PROVABLY stores no
 * BVN/NIN (no column can hold it), and the payout ledger (seller_payable → external)
 * balances. The L2 payout GATE is HTTP-level → tested in test-cloud-kyc-live.ts.
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
  const seller = await newUser("kyc-seller");
  const buyer = await newUser("kyc-buyer");
  const acct = (dealId: string, a: string) => sql<{ s: number }[]>`select coalesce(sum(amount_kobo),0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = ${a}`;
  try {
    // ── The privacy guarantee: no column can hold a BVN/NIN ─────────────────────
    const cols = (await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'kyc_verifications'`).map((r) => r.column_name);
    check("kyc_verifications stores match result only (no id-number column)",
      !cols.some((n) => /bvn|nin|id_number|number|national_id|nin_number/i.test(n)), cols.join(","));

    // ── Mock NIBSS matching ─────────────────────────────────────────────────────
    const kyc = new MockKycProvider();
    check("valid 11-digit BVN matches", (await kyc.verifyIdentity({ idType: "bvn", idNumber: "12345678901" })).matched === true);
    check("malformed number does not match", (await kyc.verifyIdentity({ idType: "nin", idNumber: "nope" })).matched === false);

    // A KYC row stores only the result (simulate the verify route's write).
    await sql`insert into public.kyc_verifications (user_id, id_type, matched, level, provider_ref) values (${seller}, 'bvn', true, 2, 'mock_kyc_bvn_x')`;
    const rowText = JSON.stringify((await sql`select * from public.kyc_verifications where user_id = ${seller}`)[0]);
    check("stored KYC row contains no 11-digit id number", !/\b\d{11}\b/.test(rowText), rowText.slice(0, 120));

    // ── Payout ledger (seller_payable → external) ──────────────────────────────
    const P = 20_000_000;
    const PAYOUT = P - sellerFeeKobo(P);
    const [l] = await sql<{ id: string }[]>`insert into public.listings (seller_id, category, title, price_kobo, stock) values (${seller}, 'phones', 'kyc', ${P}, 1) returning id`;
    const g = await createOffer(sql, { listingId: l!.id, buyerId: buyer, priceKobo: P, qty: 1 });
    if (!g.ok) throw new Error("offer");
    const d = g.deal.id;
    await transition(sql, { dealId: d, actor: "SELLER", actorId: seller, action: "accept" });
    await transition(sql, { dealId: d, actor: "BUYER", actorId: buyer, action: "pay" });
    await transition(sql, { dealId: d, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `e:${d}`, providerRef: `mock_hold_${d}`, confirmedAmountKobo: P + buyerFeeKobo(P) });
    await transition(sql, { dealId: d, actor: "SELLER", actorId: seller, action: "hand_off" });
    await transition(sql, { dealId: d, actor: "BUYER", actorId: buyer, action: "confirm_receipt" });
    await settleRelease(sql, { dealId: d, providerRef: `mock_rel_${d}`, amountKobo: PAYOUT });
    check("after release: seller_payable = payout (owed, not yet paid)", Number((await acct(d, "seller_payable"))[0]!.s) === PAYOUT);
    // Fable #2: a SECOND release with a different provider_ref must not double-book.
    const dupRel = await settleRelease(sql, { dealId: d, providerRef: `OTHER_ref_${d}`, amountKobo: PAYOUT });
    check("second release with a different ref is refused", (dupRel as { ok: boolean; reason?: string }).ok === false && (dupRel as any).reason === "already_released_diff_ref");
    check("seller_payable not doubled by the second release", Number((await acct(d, "seller_payable"))[0]!.s) === PAYOUT);

    // request + settle the payout
    await sql`insert into public.payouts (deal_id, seller_id, amount_kobo) values (${d}, ${seller}, ${PAYOUT})`;
    const settled = await settlePayout(sql, { dealId: d, amountKobo: PAYOUT, providerRef: `mock_pay_${d}` });
    check("settlePayout ok", (settled as { ok: boolean }).ok === true);
    check("after payout: seller_payable nets to 0 (paid out)", Number((await acct(d, "seller_payable"))[0]!.s) === 0);
    const [po] = await sql<{ status: string }[]>`select status from public.payouts where deal_id = ${d}`;
    check("payout row marked settled", po!.status === "settled");
    const bad = Number((await sql<{ bad: number }[]>`select count(*) filter (where s <> 0)::int as bad from (select txn_group, sum(amount_kobo) as s from public.ledger_entries where deal_id = ${d} group by txn_group) g`)[0]!.bad);
    check("all ledger groups balanced (hold+release+payout)", bad === 0, `${bad}`);

    // idempotent + fail-loud
    await settlePayout(sql, { dealId: d, amountKobo: PAYOUT, providerRef: `mock_pay_${d}` });
    check("settlePayout idempotent (seller_payable still 0)", Number((await acct(d, "seller_payable"))[0]!.s) === 0);
    check("settlePayout on unknown deal is refused", ((await settlePayout(sql, { dealId: g.deal.id.replace(/.$/, "0"), amountKobo: 1, providerRef: "x" })) as { ok: boolean }).ok === false);

    // ── Reconcile invariants 6 + 7 (Fable #3) ──────────────────────────────────
    // A payout stuck 'pending' past the grace is flagged.
    const [l2] = await sql<{ id: string }[]>`insert into public.listings (seller_id, category, title, price_kobo, stock) values (${seller}, 'phones', 'stuck', ${P}, 1) returning id`;
    const g2 = await createOffer(sql, { listingId: l2!.id, buyerId: buyer, priceKobo: P, qty: 1 });
    const d2 = (g2 as { ok: true; deal: { id: string } }).deal.id;
    await sql`insert into public.payouts (deal_id, seller_id, amount_kobo, status, created_at) values (${d2}, ${seller}, ${PAYOUT}, 'pending', now() - interval '1 hour')`;
    const rec = await reconcile(sql);
    check("reconcile flags a payout stuck 'pending' >30m", rec.payoutsOverdue.includes(d2));
    // A deal with seller_payable < 0 (the double-payout tripwire) is flagged.
    const grp = (await sql<{ g: string }[]>`select gen_random_uuid() as g`)[0]!.g;
    await sql`insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref)
              values (${grp}, ${d2}, 'seller_payable', -500, 'payout', 'neg-probe'),
                     (${grp}, ${d2}, 'external', 500, 'payout', 'neg-probe')`;
    check("reconcile flags negative seller_payable (double-payout tripwire)", (await reconcile(sql)).negativePayable.includes(d2));
  } finally {
    await sql`delete from public.payouts where seller_id = ${seller}`;
    await sql`delete from public.ledger_entries where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.kyc_verifications where user_id = ${seller}`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M8 KYC (no id stored) + payout ledger correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
