import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { fireDueDeadlines, relayOutbox, type OutboxMessage } from "../src/deals/sweeper.js";

/**
 * Sweeper core against the cloud DB (no AWS needed): backdate deadlines and prove
 *   • a due deadline fires → deal EXPIRED, event appended, deadline cleared
 *   • a STALE deadline (user rotated the token) is a no-op and the fresh future
 *     deadline survives
 *   • the outbox relay marks rows relayed via a stub sender, and a failing send
 *     leaves the row unrelayed with attempts bumped (no infinite loop)
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
const backdate = (sql: postgres.Sql, dealId: string) =>
  sql`update public.deal_deadlines set due_at = now() - interval '1 minute' where deal_id = ${dealId}`;

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("sw-seller");
  const buyer = await newUser("sw-buyer");
  const buyer3 = await newUser("sw-b3");
  const userIds = [seller, buyer, buyer3];
  try {
    const [l] = await sql<{ id: string }[]>`
      insert into public.listings (seller_id, category, title, price_kobo)
      values (${seller}, 'phones', 'sweeper-test', 20000000) returning id
    `;

    // A) a due deadline fires → EXPIRED
    const g = await createOffer(sql, { listingId: l!.id, buyerId: buyer, priceKobo: 18000000, qty: 1 });
    if (!g.ok) throw new Error("offer failed");
    const d1 = g.deal.id;
    await backdate(sql, d1);
    const r1 = await fireDueDeadlines(sql);
    check("sweep fired ≥1 deadline", r1.fired >= 1, JSON.stringify(r1));
    const [s1] = await sql<{ state: string }[]>`select state from public.deals where id = ${d1}`;
    check("deal is EXPIRED", s1!.state === "EXPIRED", s1!.state);
    const [dl1] = await sql`select 1 from public.deal_deadlines where deal_id = ${d1}`;
    check("deadline cleared after firing", !dl1);
    const [ev] = await sql<{ actor: string; action: string }[]>`
      select actor, action from public.deal_events where deal_id = ${d1} order by seq desc limit 1
    `;
    check("terminal event is SYSTEM/expire", ev!.actor === "SYSTEM" && ev!.action === "expire");

    // B) a STALE deadline is a no-op; the user's fresh deadline survives
    const g2 = await createOffer(sql, { listingId: l!.id, buyerId: buyer, priceKobo: 17000000, qty: 1 });
    // (createOffer dedupes per (listing,buyer) — the first deal is terminal, so this is a NEW deal)
    if (!g2.ok) throw new Error("offer2 failed");
    const d2 = g2.deal.id;
    await backdate(sql, d2); // make the OFFERED deadline due
    // user counters BEFORE the sweep → rotates token, reschedules deadline to future
    await transition(sql, { dealId: d2, actor: "SELLER", actorId: seller, action: "counter", priceKobo: 17500000 });
    const r2 = await fireDueDeadlines(sql); // the backdated OFFERED deadline is gone (replaced)
    const [s2] = await sql<{ state: string }[]>`select state from public.deals where id = ${d2}`;
    check("deal NOT expired (user won the race)", s2!.state === "COUNTERED_BY_SELLER", s2!.state);
    const [dl2] = await sql<{ n: number }[]>`select count(*)::int as n from public.deal_deadlines where deal_id = ${d2}`;
    check("fresh future deadline still present", (dl2 as any).n === 1 || dl2!.n === 1, JSON.stringify(dl2));

    // C) outbox relay — stub sender marks rows relayed; a failing send bumps attempts
    const before = await sql<{ n: number }[]>`select count(*)::int as n from public.outbox where relayed_at is null and deal_id in (${d1}, ${d2})`;
    const sent: OutboxMessage[] = [];
    const okRelay = await relayOutbox(sql, async (m) => { sent.push(m); });
    check("relay marked all unrelayed rows", okRelay.relayed >= (before[0]?.n ?? 0) && okRelay.failed === 0, JSON.stringify(okRelay));
    check("stub sender received messages with topic+payload", sent.length > 0 && !!sent[0]!.topic);

    // failing sender: create one more outbox row, relay with a thrower
    const g3 = await createOffer(sql, { listingId: l!.id, buyerId: buyer3, priceKobo: 16000000, qty: 1 });
    if (g3.ok) {
      const failRelay = await relayOutbox(sql, async () => { throw new Error("sqs down"); });
      check("failing send → counted failed, none marked relayed", failRelay.relayed === 0 && failRelay.failed >= 1, JSON.stringify(failRelay));
      const [att] = await sql<{ attempts: number }[]>`select attempts from public.outbox where deal_id = ${g3.deal.id} order by id desc limit 1`;
      check("failed row has attempts ≥ 1 (visible poison)", (att?.attempts ?? 0) >= 1, `${att?.attempts}`);
    }
  } finally {
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of userIds) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ sweeper fires timers + relays outbox correctly" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
