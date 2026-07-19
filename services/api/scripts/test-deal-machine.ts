import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";

/**
 * M3 internals that the HTTP surface can't reach, tested directly against the cloud
 * DB via commands.ts:
 *   • SYSTEM timer expire (the SYSTEM actor path)
 *   • the STALE-timer state_token guard (a user action after the timer was scheduled
 *     makes the timer a no-op — the "user acts at 3h59m as the 4h timer fires" race)
 *   • the DB guard trigger rejecting an illegal event insert (app-bypass backstop)
 *   • RLS: a stranger cannot read a deal/messages; a party can (role+JWT simulation)
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
function check(label: string, ok: boolean, extra = "") {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}
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

  const seller = await newUser("m-seller");
  const buyer = await newUser("m-buyer");
  const stranger = await newUser("m-stranger");
  try {
    const [listing] = await sql<{ id: string }[]>`
      insert into public.listings (seller_id, category, title, price_kobo)
      values (${seller}, 'phones', 'machine-test', 20000000) returning id
    `;
    const listingId = listing!.id;

    // A) genesis
    const g = await createOffer(sql, { listingId, buyerId: buyer, priceKobo: 18000000, qty: 1 });
    check("createOffer → OFFERED", g.ok && g.deal.state === "OFFERED");
    if (!g.ok) throw new Error("offer failed");
    const dealId = g.deal.id;
    const [dl0] = await sql<{ state_token: string; action: string }[]>`
      select state_token, action from public.deal_deadlines where deal_id = ${dealId}
    `;
    check("OFFERED deadline scheduled (expire)", dl0?.action === "expire");
    const staleToken = dl0!.state_token; // the token the timer was scheduled with

    // B) a user action rotates the token (deadline follows to the new state)
    const cnt = await transition(sql, { dealId, actor: "SELLER", actorId: seller, action: "counter", priceKobo: 19000000 });
    check("seller counter → COUNTERED_BY_SELLER (token rotated)", cnt.ok && cnt.deal.state === "COUNTERED_BY_SELLER" && cnt.deal.state_token !== staleToken);

    // C) STALE timer fires with the OLD token → no-op
    const stale = await transition(sql, { dealId, actor: "SYSTEM", action: "expire", expectedStateToken: staleToken });
    check("stale timer (old token) → no-op 'stale'", !stale.ok && stale.code === "stale");
    const [after] = await sql<{ state: string }[]>`select state from public.deals where id = ${dealId}`;
    check("deal NOT expired by the stale timer", after!.state === "COUNTERED_BY_SELLER", after!.state);

    // D) CURRENT timer fires with the live token → EXPIRED
    const [dl1] = await sql<{ state_token: string }[]>`select state_token from public.deal_deadlines where deal_id = ${dealId}`;
    const live = await transition(sql, { dealId, actor: "SYSTEM", action: "expire", expectedStateToken: dl1!.state_token, reason: "unanswered" });
    check("live timer → EXPIRED", live.ok && live.deal.state === "EXPIRED");
    const [dlGone] = await sql`select 1 from public.deal_deadlines where deal_id = ${dealId}`;
    check("deadline cleared on terminal state", !dlGone);

    // E) DB guard trigger rejects an illegal event insert (app-bypass backstop)
    let threw = false;
    try {
      await sql`
        insert into public.deal_events (deal_id, seq, actor, actor_id, action, from_state, to_state)
        values (${dealId}, 999, 'BUYER', ${buyer}, 'accept', 'OFFERED', 'ACCEPTED')
      `;
    } catch {
      threw = true;
    }
    check("DB guard rejects illegal event (BUYER accept from OFFERED)", threw);

    // E2) append-only: rewriting a deal_events row is blocked (tamper-evidence)
    let updateBlocked = false;
    try {
      await sql`update public.deal_events set to_state = 'COMPLETED' where deal_id = ${dealId} and seq = 1`;
    } catch {
      updateBlocked = true;
    }
    check("deal_events UPDATE blocked (append-only)", updateBlocked);

    // E3) outbox rows carry the (deal_id, event_seq) source for M4 dedupe/ordering
    const ob = await sql<{ n: number }[]>`
      select count(*)::int as n from public.outbox
      where deal_id = ${dealId} and event_seq is not null
    `;
    check("outbox rows tagged with deal_id + event_seq", (ob[0]?.n ?? 0) >= 2, `${ob[0]?.n}`);

    // F) RLS — party vs stranger, via role + JWT-claims simulation
    await sql`insert into public.messages (deal_id, sender_id, body) values (${dealId}, ${buyer}, 'hello')`;
    async function asUser(uid: string, q: string) {
      return sql.begin(async (tx) => {
        await tx`select set_config('role', 'authenticated', true)`;
        await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid, role: "authenticated" })}, true)`;
        return tx.unsafe(q);
      });
    }
    const buyerDeals = (await asUser(buyer, `select id from public.deals where id = '${dealId}'`)) as unknown[];
    const strangerDeals = (await asUser(stranger, `select id from public.deals where id = '${dealId}'`)) as unknown[];
    check("RLS: buyer (party) reads the deal", buyerDeals.length === 1);
    check("RLS: stranger reads 0 deals", strangerDeals.length === 0, `${strangerDeals.length}`);
    const buyerMsgs = (await asUser(buyer, `select id from public.messages where deal_id = '${dealId}'`)) as unknown[];
    const strangerMsgs = (await asUser(stranger, `select id from public.messages where deal_id = '${dealId}'`)) as unknown[];
    check("RLS: buyer reads the message", buyerMsgs.length === 1);
    check("RLS: stranger reads 0 messages", strangerMsgs.length === 0, `${strangerMsgs.length}`);
  } finally {
    // Remove deals first (RESTRICT FKs on the party ids), then the listing, then the
    // users. deal_events/messages/deadlines cascade off deals.
    const dealIds = await sql<{ id: string }[]>`
      select id from public.deals
      where buyer_id in ${sql([seller, buyer, stranger])} or seller_id in ${sql([seller, buyer, stranger])}
    `;
    if (dealIds.length) await sql`delete from public.outbox where deal_id in ${sql(dealIds.map((d) => d.id))}`;
    await sql`delete from public.deals
              where buyer_id in ${sql([seller, buyer, stranger])}
                 or seller_id in ${sql([seller, buyer, stranger])}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer, stranger]) {
      await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
    }
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M3 machine internals (timers, guard, RLS) correct" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
