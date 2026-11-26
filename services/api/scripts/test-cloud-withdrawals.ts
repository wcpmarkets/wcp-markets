import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo, transferFeeKobo } from "../src/money/fees.js";
import { createWithdrawals, failWithdrawal, reverseWithdrawal, settleWithdrawal } from "../src/money/withdrawals.js";
import { reconcile } from "../src/money/reconcile.js";

/**
 * Pooled withdrawals (0043), end to end on the mock rail against the deployed API:
 *   A. quote: every ready sale, the fee, what withdrawing everything sends
 *   B. one sale on its own; a retried key replays; a second tap while it's in flight
 *   C. withdraw everything: one transfer, one fee, a line per sale, ledger per deal
 *   D. the ₦1,000 minimum, and its waiver when a withdrawal empties the balance
 *   E. the old per-deal route still works (a one-line withdrawal)
 *   F. DB guards: lines sum to the amount, never over a deal's balance, no negative payable
 *   G. failed → sales free again; late success after failed books and flags; reversal
 *
 *   API_URL=https://…execute-api… npx tsx scripts/test-cloud-withdrawals.ts
 */
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, "");
  }
  return out;
}
const env = loadEnv(resolve(process.cwd(), "../../apps/marketing/.env.local"));
const BASE = env.SUPABASE_URL!;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY!;
const API = process.env.API_URL!.replace(/\/$/, "");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const N = (naira: number) => naira * 100;
type U = { id: string; token: string };

async function newUser(tag: string): Promise<U> {
  const email = `clitest+wd-${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${randomUUID()}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}
const api = (path: string, t: string, init: RequestInit = {}) => fetch(`${API}${path}`, { ...init, headers: H(t) });
const post = (path: string, t: string, body?: unknown) => api(path, t, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const err = async (r: Response) => ((await r.clone().json().catch(() => ({}))) as { error?: string }).error ?? "";

type Wd = { id: string; amountKobo: number; feeKobo: number; netKobo: number; status: string; lines: { dealId: string; amountKobo: number }[] };
type Earnings = {
  availableKobo: number; minWithdrawalKobo: number;
  ready: { dealId: string; amountKobo: number; feeKobo: number; canWithdrawAlone: boolean }[];
  withdrawAll: { grossKobo: number; feeKobo: number; netKobo: number; allowed: boolean; reason: string | null };
  withdrawals: Wd[];
};

async function main() {
  const sql = postgres((await fetchSsm("/wcp/api/database-url"))!, { prepare: false, max: 3 });
  const users: U[] = [];
  const seller = await newUser("seller"); users.push(seller);
  const buyer = await newUser("buyer"); users.push(buyer);
  try {
    // An ID-verified seller (the gate is L2 + a kept ID hash).
    await sql`insert into public.profiles (id, display_name, verification_level) values (${seller.id}, 'WD Test Seller', 2)
              on conflict (id) do update set verification_level = 2`;
    await sql`insert into public.kyc_verifications (user_id, id_type, matched, level, id_hash) values (${seller.id}, 'nin', true, 2, 'test-hash')
              on conflict (user_id) do update set id_hash = 'test-hash', level = 2`;

    // Completed mock-rail sales: three ordinary ones and one tiny (₦500 → ₦400 to the seller).
    const listing = async (price: number) => {
      const r = await post("/listings", seller.token, {
        lane: "goods", category: "gaming", title: `WD test ${price}`, priceKobo: N(price), condition: "used", stock: 5,
        state: "Lagos", city: "Yaba", attributes: { delivery: { modes: ["meet"] } },
      });
      const j = (await r.json()) as { id: string };
      await sql`update public.listings set status = 'active' where id = ${j.id}`;
      return j.id;
    };
    const sale = async (listingId: string) => {
      const [l] = await sql<{ price_kobo: string }[]>`select price_kobo from public.listings where id = ${listingId}`;
      const price = Number(l!.price_kobo);
      const g = await createOffer(sql, { listingId, buyerId: buyer.id, priceKobo: price, qty: 1 });
      if (!g.ok) throw new Error(`offer ${g.code}`);
      const id = g.deal.id;
      const step = async (a: Parameters<typeof transition>[1]) => { const r = await transition(sql, a); if (!(r as { ok?: boolean }).ok) throw new Error(`${a.action}: ${JSON.stringify(r).slice(0, 120)}`); };
      await step({ dealId: id, actor: "SELLER", actorId: seller.id, action: "accept" });
      await step({ dealId: id, actor: "BUYER", actorId: buyer.id, action: "pay" });
      await step({ dealId: id, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `wd:${id}`, providerRef: `mock_hold_${id}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
      await step({ dealId: id, actor: "SELLER", actorId: seller.id, action: "hand_off" });
      await step({ dealId: id, actor: "BUYER", actorId: buyer.id, action: "confirm_receipt" });
      return id;
    };
    const payable = async (dealId: string) => Number((await sql<{ s: string }[]>`
      select coalesce(sum(amount_kobo), 0)::bigint as s from public.ledger_entries where deal_id = ${dealId} and account = 'seller_payable'`)[0]!.s);
    const until = async (what: string, f: () => Promise<boolean>, secs = 90) => {
      for (let i = 0; i < secs / 3; i++) { if (await f()) return true; await sleep(3_000); }
      console.log(`   (timed out waiting for ${what})`); return false;
    };
    const earnings = async () => (await (await api("/me/payouts", seller.token)).json()) as Earnings;
    const wdStatus = async (id: string) => (await sql<{ status: string }[]>`select status from public.withdrawals where id = ${id}`)[0]?.status;

    const L1 = await listing(60_000), L2 = await listing(25_000), Ltiny = await listing(500);
    const d1 = await sale(L1), d2 = await sale(L1), d3 = await sale(L2);
    check("four sales released (seller_payable > 0)", await until("releases", async () =>
      (await Promise.all([d1, d2, d3].map(payable))).every((v) => v > 0)));

    // ── A. quote ─────────────────────────────────────────────────────────
    console.log("A. quote");
    let e = await earnings();
    const p1 = await payable(d1), p2 = await payable(d2), p3 = await payable(d3);
    check("three sales ready", e.ready.length === 3, `${e.ready.length}`);
    check("available = their payables", e.availableKobo === p1 + p2 + p3, `${e.availableKobo}`);
    check("withdraw-all: one fee on the total", e.withdrawAll.feeKobo === transferFeeKobo(p1 + p2 + p3) && e.withdrawAll.netKobo === p1 + p2 + p3 - e.withdrawAll.feeKobo && e.withdrawAll.allowed);
    check("each ready sale quotes its own fee", e.ready.every((r) => r.feeKobo === transferFeeKobo(r.amountKobo)));
    check("minimum reported as ₦1,000", e.minWithdrawalKobo === N(1_000));

    // ── B. one sale; replay; in flight ───────────────────────────────────
    console.log("B. one sale on its own");
    const key1 = `test-${randomUUID()}`;
    const b1 = await post("/me/withdrawals", seller.token, { dealIds: [d1], idempotencyKey: key1 });
    check("withdraw one sale → 201", b1.status === 201, `${b1.status} ${await err(b1)}`);
    const w1 = ((await b1.json()) as { withdrawals: Wd[] }).withdrawals[0]!;
    const w1Deal = w1.lines[0]!.dealId;
    check("one line, the whole sale, fee taken from what's sent",
      w1.lines.length === 1 && w1Deal === d1 && w1.amountKobo === p1 && w1.feeKobo === transferFeeKobo(p1) && w1.netKobo === p1 - w1.feeKobo);
    const replay = await post("/me/withdrawals", seller.token, { dealIds: [d1], idempotencyKey: key1 });
    const rj = (await replay.json()) as { withdrawals: Wd[] };
    check("same key again → 200, the same withdrawal", replay.status === 200 && rj.withdrawals[0]?.id === w1.id, `${replay.status}`);
    check("mock transfer settles", await until("w1 settle", async () => (await wdStatus(w1.id)) === "settled"));

    // Two taps at once, made in-process so nothing settles in between (through the API
    // the mock rail can settle the first before a cold second instance even starts).
    const [r2, r3] = await Promise.all([
      createWithdrawals(sql, { sellerId: seller.id, dealIds: [d2], idempotencyKey: `test-${randomUUID()}` }),
      createWithdrawals(sql, { sellerId: seller.id, dealIds: [d3], idempotencyKey: `test-${randomUUID()}` }),
    ]);
    const won = [r2, r3].filter((r) => r.ok);
    const lost = [r2, r3].find((r) => !r.ok) as { error: string } | undefined;
    check("two withdrawals at once → exactly one made, the other withdrawal_pending", won.length === 1 && lost?.error === "withdrawal_pending",
      `${r2.ok ? "ok" : (r2 as { error: string }).error}/${r3.ok ? "ok" : (r3 as { error: string }).error}`);
    const raced = won[0] && won[0].ok ? won[0].withdrawals[0]!.id : null;
    if (raced) check("…and that one settles", await until("raced settle", async () => (await wdStatus(raced)) === "settled", 150));
    check("that sale's seller_payable is now 0", (await payable(w1Deal)) === 0);
    const led = await sql<{ s: string; n: number }[]>`
      select (-sum(amount_kobo))::bigint as s, count(*)::int as n from public.ledger_entries
      where txn_group = ${w1.id} and account = 'seller_payable' and movement = 'payout'`;
    check("ledger: one payout line for the gross, grouped under the withdrawal", Number(led[0]!.s) === w1.amountKobo && led[0]!.n === 1);

    // ── C. everything ────────────────────────────────────────────────────
    console.log("C. withdraw everything");
    const dTiny = await sale(Ltiny);
    await until("tiny release", async () => (await payable(dTiny)) > 0);
    e = await earnings();
    const rest = e.ready.reduce((a, r) => a + r.amountKobo, 0);
    // ── D. minimum ───────────────────────────────────────────────────────
    console.log("D. minimum");
    const tinyReady = e.ready.find((r) => r.dealId === dTiny);
    check("the ₦400 sale can't be withdrawn alone while more is available", tinyReady?.canWithdrawAlone === false);
    const small = await post("/me/withdrawals", seller.token, { dealIds: [dTiny], idempotencyKey: `test-${randomUUID()}` });
    check("withdrawing it alone → 409 below_minimum", small.status === 409 && (await err(small)) === "below_minimum", `${small.status} ${await err(small)}`);
    const all = await post("/me/withdrawals", seller.token, { idempotencyKey: `test-${randomUUID()}` });
    const wAll = ((await all.json()) as { withdrawals: Wd[] }).withdrawals[0]!;
    check("withdraw everything → 201, one withdrawal, a line per sale", all.status === 201 && wAll.lines.length === e.ready.length && wAll.amountKobo === rest,
      `${all.status} lines=${wAll?.lines.length}`);
    check("one fee for all of them", wAll.feeKobo === transferFeeKobo(rest));
    check("it settles", await until("wAll settle", async () => (await wdStatus(wAll.id)) === "settled"));
    check("every sale's seller_payable is 0", (await Promise.all([d1, d2, d3, dTiny].map(payable))).every((v) => v === 0));
    const nothing = await post("/me/withdrawals", seller.token, { idempotencyKey: `test-${randomUUID()}` });
    check("nothing left → 409 nothing_to_withdraw", nothing.status === 409 && (await err(nothing)) === "nothing_to_withdraw");

    // A lone small balance can be emptied (the waiver), as long as it beats the fee.
    const dTiny2 = await sale(Ltiny);
    await until("tiny2 release", async () => (await payable(dTiny2)) > 0);
    const lone = await post("/me/withdrawals", seller.token, { idempotencyKey: `test-${randomUUID()}` });
    check("a ₦400 balance on its own can be withdrawn (empties the balance)", lone.status === 201, `${lone.status} ${await err(lone)}`);
    const wLone = ((await lone.clone().json()) as { withdrawals?: Wd[] }).withdrawals?.[0];
    if (wLone) await until("lone settle", async () => (await wdStatus(wLone.id)) === "settled");

    // ── E. the old route ─────────────────────────────────────────────────
    console.log("E. per-deal route (older builds)");
    const d5 = await sale(L2);
    await until("d5 release", async () => (await payable(d5)) > 0);
    const old = await post(`/deals/${d5}/payout`, seller.token);
    check("POST /deals/{id}/payout → 201, a one-line withdrawal", old.status === 201, `${old.status} ${await err(old)}`);
    const [oldW] = await sql<{ withdrawal_id: string }[]>`select withdrawal_id from public.payouts where deal_id = ${d5}`;
    check("…which settles", await until("old settle", async () => (await wdStatus(oldW!.withdrawal_id)) === "settled"));
    const again = await post(`/deals/${d5}/payout`, seller.token);
    check("…and can't be withdrawn twice → 409", again.status === 409, `${again.status} ${await err(again)}`);

    // ── F. DB guards ─────────────────────────────────────────────────────
    console.log("F. database guards");
    const d6 = await sale(L2);
    await until("d6 release", async () => (await payable(d6)) > 0);
    const bal6 = await payable(d6);
    let g1 = "";
    try {
      await sql.begin(async (t) => {
        const [w] = await t<{ id: string }[]>`insert into public.withdrawals (seller_id, amount_kobo, fee_kobo, rail) values (${seller.id}, ${bal6 + 100}, 1000, 'mock') returning id`;
        await t`insert into public.payouts (deal_id, seller_id, amount_kobo, part, withdrawal_id) values (${d6}, ${seller.id}, ${bal6 + 100}, 99, ${w!.id})`;
      });
    } catch (x) { g1 = (x as Error).message; }
    check("a line over the deal's balance is refused", g1.includes("exceeds its balance"), g1.slice(0, 70));
    let g2 = "";
    try {
      await sql.begin(async (t) => {
        const [w] = await t<{ id: string }[]>`insert into public.withdrawals (seller_id, amount_kobo, fee_kobo, rail) values (${seller.id}, ${bal6}, 1000, 'mock') returning id`;
        await t`insert into public.payouts (deal_id, seller_id, amount_kobo, part, withdrawal_id) values (${d6}, ${seller.id}, ${bal6 - 1}, 99, ${w!.id})`;
      });
    } catch (x) { g2 = (x as Error).message; }
    check("lines that don't sum to the withdrawal are refused", g2.includes("lines sum to"), g2.slice(0, 70));
    let g3 = "";
    try {
      await sql.begin(async (t) => {
        const grp = randomUUID();
        await t`insert into public.ledger_entries (txn_group, deal_id, account, amount_kobo, movement, provider_ref) values
          (${grp}, ${d6}, 'seller_payable', ${-(bal6 + 1)}, 'payout', 'test-overpay'),
          (${grp}, ${d6}, 'external', ${bal6 + 1}, 'payout', 'test-overpay')`;
      });
    } catch (x) { g3 = (x as Error).message; }
    check("paying out more than was released is refused (seller_payable ≥ 0)", g3.includes("paid out more than released"), g3.slice(0, 70));

    // ── G. failure, late success, reversal ───────────────────────────────
    console.log("G. failed / late success / reversed");
    // Made directly so the consumer doesn't settle it first.
    const mk = async (dealId: string) => sql.begin(async (t) => {
      const amt = await payable(dealId);
      const [w] = await t<{ id: string }[]>`insert into public.withdrawals (seller_id, amount_kobo, fee_kobo, rail) values (${seller.id}, ${amt}, ${transferFeeKobo(amt)}, 'paystack') returning id`;
      await t`insert into public.payouts (deal_id, seller_id, amount_kobo, part, withdrawal_id) values (${dealId}, ${seller.id}, ${amt}, (select coalesce(max(part) + 1, 0) from public.payouts where deal_id = ${dealId}), ${w!.id})`;
      return { id: w!.id, amt };
    });
    const wf = await mk(d6);
    check("a failed transfer frees the sale again", (await failWithdrawal(sql, wf.id, "test")) && (await earnings()).ready.some((r) => r.dealId === d6));
    const late = await settleWithdrawal(sql, { withdrawalId: wf.id, sentKobo: wf.amt - transferFeeKobo(wf.amt), providerRef: `test-late-${wf.id}` });
    check("a success after it was marked failed still books, and is flagged late", late.ok && (late as { late?: boolean }).late === true && (await payable(d6)) === 0);
    const wrong = await settleWithdrawal(sql, { withdrawalId: wf.id, sentKobo: 1, providerRef: "x" });
    check("a redelivered success is a no-op", wrong.ok);
    await reverseWithdrawal(sql, { withdrawalId: wf.id, reason: "test reversal" });
    check("a reversal after success books the money back to the seller", (await payable(d6)) === wf.amt && (await wdStatus(wf.id)) === "reversed");
    const [rv] = await sql<{ n: number }[]>`select count(*)::int as n from public.ledger_entries where deal_id = ${d6} and movement = 'payout_reversal'`;
    check("…with compensating ledger entries (append-only)", rv!.n === 2);
    check("…and the sale is withdrawable again", (await earnings()).ready.some((r) => r.dealId === d6));
    const wm = await mk(d6);
    const mism = await settleWithdrawal(sql, { withdrawalId: wm.id, sentKobo: wm.amt, providerRef: "gross-not-net" });
    check("a provider amount that isn't the net is refused (not booked)", !mism.ok && (await payable(d6)) === wm.amt);
    await failWithdrawal(sql, wm.id, "test cleanup");

    const rec = await reconcile(sql);
    check("reconcile: no negative payable, no unbooked withdrawal, ledger balanced",
      !rec.negativePayable.some((id) => [d1, d2, d3, dTiny, dTiny2, d5, d6].includes(id)) && rec.withdrawalsUnbooked.length === 0 && rec.globalBalanceKobo === 0,
      `neg=${rec.negativePayable.length} unbooked=${rec.withdrawalsUnbooked.length} global=${rec.globalBalanceKobo}`);
  } finally {
    // Cleanup: everything this test made.
    const deals = (await sql<{ id: string }[]>`select id from public.deals where seller_id = ${seller.id}`).map((r) => r.id);
    const wds = (await sql<{ id: string }[]>`select id from public.withdrawals where seller_id = ${seller.id}`).map((r) => r.id);
    await sql.begin(async (t) => {
      await t`select set_config('wcp.allow_review_erasure', 'on', true)`;
      await t`delete from public.reviews where deal_id = any(${deals}::uuid[])`;
    });
    await sql`delete from public.ledger_entries where deal_id = any(${deals}::uuid[])`;
    await sql`delete from public.payouts where deal_id = any(${deals}::uuid[])`;
    await sql`delete from public.withdrawals where id = any(${wds}::uuid[])`;
    await sql`delete from public.outbox where deal_id = any(${deals}::uuid[]) or (topic = 'escrow.withdrawal' and payload->>'withdrawalId' = any(${wds}::text[]))`;
    await sql`delete from public.reconciliation_exceptions where payload->>'withdrawalId' = any(${wds}::text[])`;
    await sql`delete from public.notifications where user_id in (${seller.id}, ${buyer.id})`;
    await sql`delete from public.deals where id = any(${deals}::uuid[])`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql`delete from public.kyc_verifications where user_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ pooled withdrawals" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
