import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Device-testing helper (not a test): a throwaway `clitest+` host with one live shortlet,
 * so the app on a real phone can book it, pay, and cancel.
 *
 *   API_URL=… npx tsx scripts/dev-shortlet-host.ts setup     → host + listing (state in the OS temp dir)
 *   API_URL=… npx tsx scripts/dev-shortlet-host.ts status    → the host's bookings + states
 *   API_URL=… npx tsx scripts/dev-shortlet-host.ts cleanup   → deletes everything it made
 *
 * The state file holds the host's session token, so it lives in the OS temp dir (never
 * in the repo), is never printed, and is deleted on cleanup.
 */
const STATE = resolve(tmpdir(), "wcp-dev-shortlet.json");
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
const API = (process.env.API_URL ?? "").replace(/\/$/, "");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

async function main() {
  const cmd = process.argv[2];
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 1 });
  try {
    if (cmd === "setup") {
      if (existsSync(STATE)) throw new Error("already set up — run cleanup first");
      const email = `clitest+devhost${Date.now()}@wcp-test.local`;
      const password = `Test-${Math.random().toString(36).slice(2)}9!`;
      const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
      const { id } = (await cr.json()) as { id: string };
      const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      const token = ((await si.json()) as { access_token: string }).access_token;
      await sql`update public.profiles set display_name = 'Adaeze (test host)' where id = ${id}`.catch(() => {});
      const lr = await fetch(`${API}/listings`, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          lane: "property", category: "Shortlets", title: "Studio · Yaba (3F cancel test)", description: "Device test listing — will be deleted.",
          state: "Lagos", city: "Yaba", priceKobo: 30_000_00,
          attributes: { propertyType: "apartment", dealType: "shortlet", beds: 1, minNights: 2, maxGuests: 2, cleaningKobo: 5_000_00, cautionKobo: 10_000_00, amenities: ["power", "water", "wifi", "parking"] },
        }),
      });
      const L = (await lr.json()) as { id?: string; error?: string };
      if (lr.status !== 201) throw new Error(`listing ${lr.status} ${L.error ?? ""}`);
      writeFileSync(STATE, JSON.stringify({ id, token, listingId: L.id }));
      console.log(`host ${id}\nlisting ${L.id} (₦30,000/night, min 2, ₦5k cleaning, ₦10k deposit)`);
    } else if (cmd === "service") {
      // The same host also offers a service, to try a quote request (with photos) on the phone.
      const s = JSON.parse(readFileSync(STATE, "utf8")) as { token: string };
      const lr = await fetch(`${API}/listings`, {
        method: "POST", headers: { Authorization: `Bearer ${s.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          lane: "services", category: "Home Services", title: "Plumbing (3F photo test)", description: "Device test listing — will be deleted.",
          priceKobo: 999, state: "Lagos", city: "Yaba",
          attributes: { serviceType: "Plumbing", rateCard: [{ name: "Leak repair & diagnosis", fromKobo: 8_000_00 }], coverageKm: 5, availability: ["today"] },
        }),
      });
      const L = (await lr.json()) as { id?: string; error?: string };
      console.log(lr.status === 201 ? `service listing ${L.id}` : `service ${lr.status} ${L.error ?? ""}`);
    } else if (cmd === "status") {
      const s = JSON.parse(readFileSync(STATE, "utf8")) as { id: string };
      const rows = await sql`select d.id, d.state, b.check_in, b.check_out, b.active from public.deals d left join public.bookings b on b.deal_id = d.id where d.seller_id = ${s.id} order by d.created_at`;
      for (const r of rows) console.log(`${r.id} ${r.state} ${r.check_in?.toISOString?.().slice(0, 10) ?? ""}→${r.check_out?.toISOString?.().slice(0, 10) ?? ""} active=${r.active}`);
      if (!rows.length) console.log("no bookings");
    } else if (cmd === "cleanup") {
      const s = JSON.parse(readFileSync(STATE, "utf8")) as { id: string };
      const deals = sql`select id from public.deals where seller_id = ${s.id}`;
      await sql`delete from public.dispute_cases where deal_id in (${deals})`.catch(() => {});
      await sql`delete from public.ledger_entries where deal_id in (${deals})`;
      await sql`delete from public.outbox where deal_id in (${deals})`;
      await sql`delete from public.payouts where deal_id in (${deals})`;
      await sql`delete from public.deal_milestones where deal_id in (${deals})`;
      await sql`delete from public.bookings where deal_id in (${deals})`;
      const convs = sql`select id from public.conversations where seller_id = ${s.id}`;
      await sql`delete from public.messages where conversation_id in (${convs})`.catch(() => {});
      await sql`delete from public.deals where seller_id = ${s.id}`;
      await sql`delete from public.conversations where seller_id = ${s.id}`.catch(() => {});
      await sql`delete from public.listings where seller_id = ${s.id}`;
      await fetch(`${BASE}/auth/v1/admin/users/${s.id}`, { method: "DELETE", headers: admin });
      unlinkSync(STATE);
      const left = await sql`select count(*)::int as n from public.deals where seller_id = ${s.id}`;
      console.log(`cleaned up; deals left: ${left[0]!.n}`);
    } else {
      console.log("usage: setup | status | cleanup");
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("FAIL", (e as Error).message); process.exit(1); });
