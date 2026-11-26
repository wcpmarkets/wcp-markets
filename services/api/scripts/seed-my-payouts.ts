import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo, transferFeeKobo } from "../src/money/fees.js";
import { failWithdrawal, reverseWithdrawal, settleWithdrawal } from "../src/money/withdrawals.js";

/**
 * Payout history for a store seeded by scripts/seed-my-store.ts, so the Payouts
 * screen, the Withdraw sheet and the deal screens have every state to show. Writes
 * to the LIVE database, on the mock rail — no money moves anywhere.
 *
 *   SEED_PHONE=234XXXXXXXXXX npx tsx scripts/seed-my-payouts.ts
 *
 * Makes, from the store seed's six completed sales plus a few more by new test buyers:
 *   - a paid withdrawal of three sales (12 days ago) and one of a single sale (5 days)
 *   - one that didn't go through (3 days) and one returned by the bank (2 days):
 *     both sales are back under Ready, as they would be for real
 *   - one on its way (today)
 *   - two more ready sales, and two deals still in escrow (paid, handed off)
 *
 * Withdrawals are written directly, skipping the API's ID-verification and payout-
 * account gates (the account has neither), then settled / failed / reversed through
 * the real ledger code so every balance is what the app would compute. The bank shown
 * on them is a placeholder ("Demo Bank ···0000"), not the seller's.
 *
 * Removed by scripts/cleanup-my-store-seed.ts (seed buyers' deals + seed:* withdrawals).
 * Note: the withdrawal "on its way" holds the one-pending-per-seller slot, so a real
 * withdrawal by this account is refused until cleanup.
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
const PHONE = process.env.SEED_PHONE?.replace(/\D/g, "");
if (!PHONE) throw new Error("set SEED_PHONE");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const DOMAIN = "wcp-seed.local";
const BANK = { name: "Demo Bank", last4: "0000" };

/** More test buyers (cleanup matches seed-buyer-%). */
const BUYERS = [
  { name: "Emeka Nwosu", on: "iPhone" },        // ready
  { name: "Halima Sani", on: "Nintendo" },      // ready
  { name: "Segun Bakare", on: "EliteBook" },    // on its way
  { name: "Grace Okon", on: "PlayStation" },    // in escrow: paid
  { name: "Yusuf Abdullahi", on: "iPhone" },    // in escrow: handed off
];

async function main() {
  const sql = postgres((await fetchSsm("/wcp/api/database-url"))!, { prepare: false, max: 2 });
  const started = new Date();
  try {
    const [target] = await sql<{ id: string }[]>`select id from auth.users where phone = ${PHONE!}`;
    if (!target) throw new Error("no account with that phone");
    const seller = target.id;
    const [helper] = await sql`select 1 from auth.users where email = ${`seed-helper@${DOMAIN}`}`;
    if (!helper) throw new Error("run scripts/seed-my-store.ts first");
    const [done] = await sql`select 1 from public.withdrawals where seller_id = ${seller} and idempotency_key like 'seed:%'`;
    if (done) throw new Error("already seeded — run scripts/cleanup-my-store-seed.ts first");

    const listings = await sql<{ id: string; title: string; price_kobo: string }[]>`
      select id, title, price_kobo from public.listings where seller_id = ${seller} and lane = 'goods' and status = 'active'`;
    const listingFor = (word: string) => {
      const l = listings.find((x) => x.title.includes(word));
      if (!l) throw new Error(`no seeded listing like ${word}`);
      return l;
    };

    // ── More sales by new test buyers ─────────────────────────────────────────
    const made: Record<string, string> = {};
    let n = 0;
    for (const b of BUYERS) {
      n++;
      const r = await fetch(`${BASE}/auth/v1/admin/users`, {
        method: "POST", headers: admin,
        body: JSON.stringify({ email: `seed-buyer-p${n}@${DOMAIN}`, password: `Seed-${randomUUID()}9!`, email_confirm: true }),
      });
      const buyer = ((await r.json()) as { id: string }).id;
      if (!buyer) throw new Error(`buyer ${b.name}: ${r.status}`);
      await sql`insert into public.profiles (id, display_name) values (${buyer}, ${b.name}) on conflict (id) do update set display_name = ${b.name}`;
      const l = listingFor(b.on);
      const price = Number(l.price_kobo);
      // A paid sale takes a unit of stock; add it first so the store's listings end
      // as they were (otherwise they'd read as sold out, or the sale auto-refunds).
      await sql`update public.listings set stock = stock + 1 where id = ${l.id}`;
      const g = await createOffer(sql, { listingId: l.id, buyerId: buyer, priceKobo: price, qty: 1 });
      if (!g.ok) throw new Error(`offer ${b.name}: ${g.code}`);
      const deal = g.deal.id;
      const step = async (a: Parameters<typeof transition>[1]) => {
        const res = await transition(sql, a);
        if (!(res as { ok?: boolean }).ok) throw new Error(`${a.action}: ${JSON.stringify(res).slice(0, 120)}`);
      };
      await step({ dealId: deal, actor: "SELLER", actorId: seller, action: "accept" });
      await step({ dealId: deal, actor: "BUYER", actorId: buyer, action: "pay" });
      await step({ dealId: deal, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `seed:${deal}`, providerRef: `mock_hold_${deal}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
      if (n <= 3 || n === 5) await step({ dealId: deal, actor: "SELLER", actorId: seller, action: "hand_off" });
      if (n <= 3) await step({ dealId: deal, actor: "BUYER", actorId: buyer, action: "confirm_receipt" });
      made[`p${n}`] = deal;
      console.log(`sale ${n}: ${l.title.slice(0, 32)} → ${n <= 3 ? "completed" : n === 4 ? "paid, in escrow" : "handed off, in escrow"}`);
    }

    // Completed sales release on the consumer; wait until each owes the seller.
    const payable = async (d: string) => Number((await sql<{ s: string }[]>`
      select coalesce(sum(amount_kobo), 0)::bigint as s from public.ledger_entries where deal_id = ${d} and account = 'seller_payable'`)[0]!.s);
    for (let i = 0; i < 40; i++) {
      if ((await Promise.all(["p1", "p2", "p3"].map((k) => payable(made[k]!)))).every((v) => v > 0)) break;
      await new Promise((r) => setTimeout(r, 3_000));
    }

    // The store seed's six sales, oldest first.
    const old = await sql<{ id: string; title: string }[]>`
      select d.id, l.title from public.deals d join public.listings l on l.id = d.listing_id
      join auth.users u on u.id = d.buyer_id
      where d.seller_id = ${seller} and d.state = 'COMPLETED' and u.email like ${`seed-buyer-%@${DOMAIN}`}
        and u.email not like ${`seed-buyer-p%@${DOMAIN}`}
      order by d.created_at`;
    if (old.length < 6) throw new Error(`expected the store seed's 6 sales, found ${old.length}`);
    const pick = (word: string, skip = 0) => old.filter((d) => d.title.includes(word))[skip]!.id;

    // ── Withdrawals ───────────────────────────────────────────────────────────
    const withdraw = async (dealIds: string[], key: string, daysAgo: number) => {
      const id = await sql.begin(async (t) => {
        const amts = await Promise.all(dealIds.map(payable));
        const total = amts.reduce((a, b) => a + b, 0);
        const [w] = await t<{ id: string }[]>`
          insert into public.withdrawals (seller_id, amount_kobo, fee_kobo, rail, bank_name, account_last4, idempotency_key)
          values (${seller}, ${total}, ${transferFeeKobo(total)}, 'mock', ${BANK.name}, ${BANK.last4}, ${`seed:${key}`}) returning id`;
        for (let i = 0; i < dealIds.length; i++) {
          await t`insert into public.payouts (deal_id, seller_id, amount_kobo, part, withdrawal_id)
                  values (${dealIds[i]!}, ${seller}, ${amts[i]!},
                          (select coalesce(max(part) + 1, 0) from public.payouts where deal_id = ${dealIds[i]!}), ${w!.id})`;
        }
        return w!.id;
      });
      return { id, when: new Date(Date.now() - daysAgo * 86_400_000) };
    };
    const backdate = async (w: { id: string; when: Date }, settled: boolean) => {
      const at = w.when, done = new Date(at.getTime() + 25 * 60_000);
      await sql`update public.withdrawals set created_at = ${at}, updated_at = ${done}, settled_at = ${settled ? done : null} where id = ${w.id}`;
      await sql`update public.payouts set created_at = ${at}, settled_at = ${settled ? done : null} where withdrawal_id = ${w.id}`;
    };
    const settle = async (w: { id: string }) => {
      const [r] = await sql<{ amount_kobo: string; fee_kobo: string }[]>`select amount_kobo, fee_kobo from public.withdrawals where id = ${w.id}`;
      const res = await settleWithdrawal(sql, { withdrawalId: w.id, sentKobo: Number(r!.amount_kobo) - Number(r!.fee_kobo), providerRef: `mock_wd_${w.id}` });
      if (!res.ok) throw new Error(`settle: ${res.reason}`);
    };

    const w1 = await withdraw([pick("EliteBook"), pick("Nintendo"), pick("iPhone")], "three-sales", 12);
    await settle(w1); await backdate(w1, true);
    console.log("withdrawal: 3 sales, paid (12 days ago)");

    const w2 = await withdraw([pick("PlayStation")], "one-sale", 5);
    await settle(w2); await backdate(w2, true);
    console.log("withdrawal: 1 sale, paid (5 days ago)");

    const w3 = await withdraw([pick("EliteBook", 1)], "failed", 3);
    await failWithdrawal(sql, w3.id, "Seed: the bank declined the transfer");
    await backdate(w3, false);
    console.log("withdrawal: didn't go through (3 days ago) — its sale is ready again");

    const w4 = await withdraw([pick("PlayStation", 1)], "reversed", 2);
    await settle(w4);
    await reverseWithdrawal(sql, { withdrawalId: w4.id, reason: "Seed: returned by the bank" });
    await backdate(w4, true);
    console.log("withdrawal: returned by the bank (2 days ago) — its sale is ready again");

    const w5 = await withdraw([made.p3!], "on-its-way", 0);
    console.log("withdrawal: 1 sale, on its way (today)");

    // The new deals' notifications aren't news: mark them read once the outbox relays.
    await new Promise((r) => setTimeout(r, 75_000));
    const read = await sql`update public.notifications set read_at = now() where user_id = ${seller} and created_at >= ${started} and read_at is null returning id`;
    console.log(`marked ${read.length} seed notification(s) read`);
    void w5;
    console.log("\nDONE ✅");
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
