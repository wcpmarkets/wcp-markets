import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer } from "../src/deals/commands.js";

/**
 * Live proof the DEPLOYED sweeper cron works: create an OFFERED deal, backdate its
 * deadline into the past, then WAIT for the EventBridge 60s tick to fire it — no
 * manual invoke. Asserts the deal auto-expired and its outbox rows were relayed
 * (relayed_at set) to SQS by the Lambda. This is M3's "offer auto-expires" gate.
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("live-seller");
  const buyer = await newUser("live-buyer");
  try {
    const [l] = await sql<{ id: string }[]>`
      insert into public.listings (seller_id, category, title, price_kobo)
      values (${seller}, 'phones', 'live-sweeper', 20000000) returning id
    `;
    const g = await createOffer(sql, { listingId: l!.id, buyerId: buyer, priceKobo: 18000000, qty: 1 });
    if (!g.ok) throw new Error("offer failed");
    const dealId = g.deal.id;
    await sql`update public.deal_deadlines set due_at = now() - interval '5 minutes' where deal_id = ${dealId}`;
    console.log(`0) deal ${dealId.slice(0, 8)} OFFERED, deadline backdated — waiting for the 60s cron…`);

    // Poll up to ~130s (two ticks) for the deployed cron to fire it.
    let state = "OFFERED";
    for (let i = 0; i < 13; i++) {
      await sleep(10_000);
      const [row] = await sql<{ state: string }[]>`select state from public.deals where id = ${dealId}`;
      state = row!.state;
      process.stdout.write(`   t+${(i + 1) * 10}s: ${state}\n`);
      if (state === "EXPIRED") break;
    }
    check("deployed cron auto-expired the deal", state === "EXPIRED", state);
    const [ev] = await sql<{ actor: string; action: string; reason: string | null }[]>`
      select actor, action, reason from public.deal_events where deal_id = ${dealId} order by seq desc limit 1
    `;
    check("expiry event is SYSTEM/expire", ev?.actor === "SYSTEM" && ev?.action === "expire", `${ev?.actor}/${ev?.action}`);
    const [ob] = await sql<{ pending: number; relayed: number }[]>`
      select count(*) filter (where relayed_at is null)::int as pending,
             count(*) filter (where relayed_at is not null)::int as relayed
      from public.outbox where deal_id = ${dealId}
    `;
    check("sweeper relayed this deal's outbox rows to SQS", (ob?.relayed ?? 0) >= 1 && (ob?.pending ?? 1) === 0, JSON.stringify(ob));
  } finally {
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller})`;
    await sql`delete from public.deals where seller_id = ${seller}`;
    await sql`delete from public.listings where seller_id = ${seller}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer]) await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ deployed sweeper cron auto-expires + relays live" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
