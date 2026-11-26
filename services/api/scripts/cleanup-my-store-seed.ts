import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Removes everything scripts/seed-my-store.ts made, and nothing else: the seeded
 * listings (with their photos), the test buyers' deals and reviews and every row hung
 * off them, the withdrawals scripts/seed-my-payouts.ts made (idempotency key seed:*),
 * the notifications they caused, and the @wcp-seed.local accounts.
 * The seeded seller's own account and anything they made themselves is untouched.
 *
 *   npx tsx scripts/cleanup-my-store-seed.ts            # dry run: counts only
 *   npx tsx scripts/cleanup-my-store-seed.ts --apply    # delete
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
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const APPLY = process.argv.includes("--apply");
const DOMAIN = "wcp-seed.local";

async function main() {
  const sql = postgres((await fetchSsm("/wcp/api/database-url"))!, { prepare: false, max: 2 });
  try {
    const [helper] = await sql<{ id: string; meta: { seed?: { seller: string; listings: string[] } } }[]>`
      select id, raw_app_meta_data as meta from auth.users where email = ${`seed-helper@${DOMAIN}`}`;
    const seed = helper?.meta?.seed;
    const listings = seed?.listings ?? [];
    const buyers = (await sql<{ id: string }[]>`select id from auth.users where email like ${`seed-buyer-%@${DOMAIN}`}`).map((r) => r.id);
    const deals = (await sql<{ id: string }[]>`
      select id from public.deals where listing_id = any(${listings}::uuid[]) or buyer_id = any(${buyers}::uuid[])`).map((r) => r.id);
    const photos = (await sql<{ p: string }[]>`
      select unnest(image_paths) as p from public.listings where id = any(${listings}::uuid[])`).map((r) => r.p);
    console.log(`helper: ${helper ? "yes" : "none"} · listings ${listings.length} · photos ${photos.length} · buyers ${buyers.length} · deals ${deals.length}`);
    if (!APPLY) { console.log("dry run — pass --apply to delete"); return; }

    await sql.begin(async (tx) => {
      await tx`select set_config('wcp.allow_review_erasure', 'on', true)`;
      await tx`delete from public.reviews where deal_id = any(${deals}::uuid[])`;
    });
    for (const t of ["ledger_entries", "payments", "payment_refunds", "payouts", "deal_milestones", "dispute_cases", "bookings", "outbox"]) {
      const r = await sql`delete from ${sql("public." + t)} where deal_id = any(${deals}::uuid[]) returning 1`.catch((e) => { throw new Error(`${t}: ${e.message}`); });
      if (r.length) console.log(`   ${t}: ${r.length}`);
    }
    // seed-my-payouts.ts: its withdrawals (their lines went with the deals' payouts above).
    if (seed?.seller) {
      const w = await sql`delete from public.withdrawals where seller_id = ${seed.seller} and idempotency_key like 'seed:%' returning 1`;
      if (w.length) console.log(`   withdrawals: ${w.length}`);
      // A payout account seeded without a real Paystack recipient (seed_rcp_*); a real one is kept.
      const pa = await sql`delete from public.payout_accounts where user_id = ${seed.seller} and recipient_code like 'seed_rcp_%' returning 1`;
      if (pa.length) console.log(`   seeded payout account: ${pa.length}`);
    }
    if (seed?.seller) {
      const n = await sql`
        delete from public.notifications where user_id = ${seed.seller}
          and (data->>'dealId' = any(${deals}::text[]) or data->>'listingId' = any(${listings}::text[])) returning 1`;
      console.log(`   notifications: ${n.length}`);
    }
    await sql`delete from public.deals where id = any(${deals}::uuid[])`;
    await sql`delete from public.bookings where listing_id = any(${listings}::uuid[])`;
    await sql`delete from public.listings where id = any(${listings}::uuid[])`; // conversations, saves, views cascade
    if (photos.length) {
      const r = await fetch(`${BASE}/storage/v1/object/listing-images`, { method: "DELETE", headers: admin, body: JSON.stringify({ prefixes: photos }) });
      console.log(`   photos removed: ${r.ok}`);
    }
    for (const u of [...buyers, ...(helper ? [helper.id] : [])]) {
      await fetch(`${BASE}/auth/v1/admin/users/${u}`, { method: "DELETE", headers: admin });
    }
    console.log(`\nremoved ${listings.length} listings, ${deals.length} deals and reviews, ${buyers.length + (helper ? 1 : 0)} seed accounts ✅`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
