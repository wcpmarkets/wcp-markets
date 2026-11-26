import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";
import { createOffer, transition } from "../src/deals/commands.js";
import { buyerFeeKobo } from "../src/money/fees.js";

/**
 * Seed a real account's store with listings in all four lanes, plus reviews from test
 * buyers who each completed a mock-paid deal — so the store, reviews, activity and
 * listing screens have real data. Writes to the LIVE database.
 *
 *   SEED_PHONE=234XXXXXXXXXX API_URL=https://…execute-api… npx tsx scripts/seed-my-store.ts
 *
 * How it stays honest with the rest of the system:
 * - Listings are POSTed through the API (contract, lane rules, screening) by a helper
 *   account, then moved to the target seller. The API only takes the owner's own
 *   session, and we never hold one for a real person.
 * - Reviews need a COMPLETED deal written by its buyer (DB trigger). Each test buyer
 *   runs a real offer → accept → pay → confirm → hand-off → receipt through the deal
 *   commands, on the mock escrow rail, so the ledger stays balanced.
 *
 * Everything is tagged for removal by scripts/cleanup-my-store-seed.ts: the helper and
 * buyers use @wcp-seed.local emails, and the helper's app_metadata lists the listings.
 * Refuses to run twice (clean up first).
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
const API = process.env.API_URL!;
const PHONE = process.env.SEED_PHONE?.replace(/\D/g, "");
if (!API || !PHONE) throw new Error("set API_URL and SEED_PHONE");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const N = (naira: number) => naira * 100;
export const SEED_DOMAIN = "wcp-seed.local";
const HELPER_EMAIL = `seed-helper@${SEED_DOMAIN}`;
const BUCKET = "listing-images";
const STATE = "Abuja (FCT)";

/** Photos already in the bucket (the demo listings'), copied — never shared. */
type Photo = { copyOf: string; nth?: number } | { commons: string };
type Seed = { key: string; body: Record<string, unknown>; photos: Photo[] };

const goods = (category: string, title: string, description: string, price: number, condition: string, stock: number, city: string, attrs: Record<string, unknown>, photos: Photo[], key: string): Seed => ({
  key, photos,
  body: {
    lane: "goods", category, title, description, priceKobo: N(price), condition, stock, negotiable: true,
    state: STATE, city, location: `${city}, Abuja`,
    attributes: { delivery: { modes: ["deliver", "meet"] }, ...attrs },
  },
});

const SEEDS: Seed[] = [
  goods("phones", "iPhone 13 Pro — 128GB, Graphite", "UK-used, battery health 89%, Face ID and True Tone working. No scratches on the screen. Comes with box and a USB-C to Lightning cable.", 520_000, "used", 2, "Gwarinpa",
    { brand: "Apple", storage: "128GB", warranty: "1m" }, [{ copyOf: "iPhone 13 Pro — 128GB, Graphite" }], "iphone"),
  goods("gaming", "Sony PlayStation 5 Slim (Disc Edition)", "Brand new and sealed, with one DualSense controller. Receipt available. Pick up in Wuse or I deliver across Abuja.", 780_000, "new", 4, "Wuse",
    { brand: "Sony", warranty: "manufacturer" }, [{ copyOf: "Sony PlayStation 5 Slim (Disc)" }], "ps5"),
  goods("laptops", "HP EliteBook 840 G8 — Core i7, 16GB, 512GB SSD", "Refurbished to a high standard: new battery, Windows 11 Pro activated, backlit keyboard. Ideal for work and school.", 610_000, "refurbished", 3, "Gwarinpa",
    { brand: "HP", ram: "16GB", storage: "512GB", warranty: "3m" }, [{ copyOf: "HP EliteBook 840 G8 — i7, 16GB" }], "elitebook"),
  goods("tv-audio", "Samsung 55\" QLED 4K Smart TV", "Used for eight months, perfect picture with no dead pixels. Remote and wall bracket included.", 430_000, "used", 1, "Gwarinpa",
    { brand: "Samsung", screen: "55\"", warranty: "7d" }, [{ copyOf: "Samsung 55\" QLED 4K Smart TV" }], "tv"),
  goods("gaming", "Nintendo Switch OLED — White", "Lightly used, screen protector on since day one. Dock, Joy-Cons, charger and two games included.", 210_000, "used", 2, "Gwarinpa",
    { brand: "Nintendo", warranty: "7d" }, [{ copyOf: "Nintendo Switch OLED — White" }], "switch"),
  {
    key: "flat",
    photos: [{ copyOf: "2-bed flat, Lekki Phase 1", nth: 0 }, { copyOf: "2-bed flat, Lekki Phase 1", nth: 1 }],
    body: {
      lane: "property", category: "apartment", title: "2-bedroom flat to let, Gwarinpa",
      description: "Spacious 2-bed, both rooms en-suite, in a quiet estate off 3rd Avenue. Prepaid meter, borehole, POP ceilings and 24-hour security. Yearly rent.",
      priceKobo: N(3_500_000), state: STATE, city: "Gwarinpa", location: "Gwarinpa, Abuja",
      attributes: { propertyType: "apartment", dealType: "rent", beds: 2, baths: 2, amenities: ["power", "water", "security", "parking"] },
    },
  },
  {
    key: "shortlet",
    photos: [{ copyOf: "2-bed flat, Lekki Phase 1", nth: 1 }, { copyOf: "2-bed flat, Lekki Phase 1", nth: 0 }],
    body: {
      lane: "property", category: "apartment", title: "Serviced 1-bed shortlet, Wuse 2",
      description: "Fully serviced 1-bed with fast Wi-Fi, 24/7 power and a fitted kitchen. Close to Banex and the restaurants on Aminu Kano Crescent.",
      priceKobo: N(45_000), state: STATE, city: "Wuse", location: "Wuse 2, Abuja",
      attributes: {
        propertyType: "apartment", dealType: "shortlet", beds: 1, baths: 1, minNights: 2, maxGuests: 2,
        cleaningKobo: N(10_000), cautionKobo: N(50_000), amenities: ["power", "wifi", "ac", "security", "parking", "kitchen"],
      },
    },
  },
  {
    key: "camry",
    photos: [{ commons: "File:2020 Toyota Camry XSE front.jpg" }],
    body: {
      lane: "vehicles", category: "cars", title: "Toyota Camry XSE 2020", priceKobo: N(23_500_000),
      description: "Foreign used, accident-free with clean title. Full options: leather, sunroof, reverse camera. Duty fully paid.",
      state: STATE, city: "Gwarinpa", location: "Gwarinpa, Abuja",
      attributes: { make: "Toyota", model: "Camry", year: 2020, mileageKm: 48_000, transmission: "automatic", fuel: "petrol", body: "saloon", vehicleCondition: "foreign_used", registration: "registered" },
    },
  },
  {
    key: "lexus",
    photos: [{ commons: "File:2016 Lexus RX350, Front Left, 04-05-2021.jpg" }],
    body: {
      lane: "vehicles", category: "cars", title: "Lexus RX 350 2016", priceKobo: N(27_000_000),
      description: "Nigerian used, one owner, serviced at the dealer. Cold AC, no faults, all papers complete.",
      state: STATE, city: "Wuse", location: "Wuse, Abuja",
      attributes: { make: "Lexus", model: "RX 350", year: 2016, mileageKm: 86_000, transmission: "automatic", fuel: "petrol", body: "suv", vehicleCondition: "nigerian_used", registration: "registered" },
    },
  },
  {
    key: "repairs",
    photos: [{ commons: "File:Réparateur-dépanneur de téléphones mobiles 1.jpg" }],
    body: {
      lane: "services", category: "Repair & Construction", title: "Phone & laptop repairs — Gwarinpa",
      description: "Screens, batteries, charging ports and water damage, for iPhone, Samsung, Tecno and most laptops. Most phone repairs done same day, with a 30-day warranty on parts.",
      priceKobo: 0, state: STATE, city: "Gwarinpa", location: "Gwarinpa, Abuja",
      attributes: {
        serviceType: "Phone & laptop repair",
        rateCard: [
          { name: "Screen replacement", fromKobo: N(25_000) },
          { name: "Battery replacement", fromKobo: N(12_000) },
          { name: "Laptop diagnosis & repair", fromKobo: N(15_000) },
          { name: "Water damage recovery" },
        ],
        coverageKm: 10, availability: ["today", "this_week"],
      },
    },
  },
];

/** Six buyers, each completing one deal and leaving one review. */
const REVIEWS = [
  { name: "Chinedu Okafor", on: "ps5", rating: 5, body: "Sealed PS5 exactly as listed. We met at Wuse, quick and friendly, and escrow made it stress-free." },
  { name: "Aisha Bello", on: "elitebook", rating: 5, body: "The laptop looks almost new and the battery holds well. Would buy from this store again." },
  { name: "Tunde Adeyemi", on: "iphone", rating: 4, body: "Phone is clean and the battery health was as described. Delivery took a day longer than promised." },
  { name: "Ngozi Eze", on: "switch", rating: 5, body: null },
  { name: "Ibrahim Musa", on: "ps5", rating: 3, body: "Console works fine, but I waited two days for a reply before we agreed on pickup." },
  { name: "Funke Ajayi", on: "elitebook", rating: 2, body: "The charger wasn't original and one key sticks a little. The seller offered a fix; still waiting on it." },
];

const pw = () => `Seed-${randomUUID()}9!`;
async function createUser(body: object): Promise<string> {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify(body) });
  const j = (await r.json()) as { id?: string };
  if (!r.ok || !j.id) throw new Error(`create user ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.id;
}

async function storagePut(key: string, bytes: ArrayBuffer, type: string) {
  const r = await fetch(`${BASE}/storage/v1/object/${BUCKET}/${key}`, {
    method: "POST", headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": type }, body: bytes,
  });
  if (!r.ok) throw new Error(`upload ${r.status} ${await r.text()}`);
}
async function storageCopy(from: string, to: string) {
  const r = await fetch(`${BASE}/storage/v1/object/copy`, { method: "POST", headers: admin, body: JSON.stringify({ bucketId: BUCKET, sourceKey: from, destinationKey: to }) });
  if (!r.ok) throw new Error(`copy ${r.status} ${await r.text()}`);
}
/** A Commons file's 1280px rendering, fetched into memory (never written to disk). */
async function commonsJpeg(title: string): Promise<ArrayBuffer> {
  const q = new URLSearchParams({ action: "query", format: "json", titles: title, prop: "imageinfo", iiprop: "url", iiurlwidth: "1280" });
  const meta = (await (await fetch(`https://commons.wikimedia.org/w/api.php?${q}`, { headers: { "User-Agent": "wcp-seed-script/1.0" } })).json()) as any;
  const url = (Object.values(meta.query.pages)[0] as any).imageinfo[0].thumburl as string;
  const r = await fetch(url, { headers: { "User-Agent": "wcp-seed-script/1.0" } });
  if (!r.ok) throw new Error(`commons ${r.status} ${title}`);
  return r.arrayBuffer();
}

async function main() {
  const sql = postgres((await fetchSsm("/wcp/api/database-url"))!, { prepare: false, max: 2 });
  const started = new Date();
  try {
    const [target] = await sql<{ id: string }[]>`select id from auth.users where phone = ${PHONE!}`;
    if (!target) throw new Error("no account with that phone");
    const seller = target.id;
    const [already] = await sql`select 1 from auth.users where email = ${HELPER_EMAIL}`;
    if (already) throw new Error("already seeded — run scripts/cleanup-my-store-seed.ts first");

    // ── Helper account: posts the listings through the API ────────────────────
    const helperPw = pw();
    const helper = await createUser({ email: HELPER_EMAIL, password: helperPw, email_confirm: true });
    const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email: HELPER_EMAIL, password: helperPw }) });
    const token = ((await si.json()) as { access_token: string }).access_token;

    const ids: Record<string, string> = {};
    for (const s of SEEDS) {
      const r = await fetch(`${API}/listings`, { method: "POST", headers: H(token), body: JSON.stringify(s.body) });
      const j = (await r.json()) as { id?: string; status?: string; error?: string };
      if (!r.ok || !j.id) throw new Error(`listing ${s.key}: ${r.status} ${j.error ?? ""}`);
      ids[s.key] = j.id;
      // Photos under the seller's own prefix, as the app's upload would store them.
      const paths: string[] = [];
      for (const p of s.photos) {
        const dest = `${seller}/${j.id}/${randomUUID()}.jpg`;
        if ("copyOf" in p) {
          const [src] = await sql<{ image_paths: string[] }[]>`
            select image_paths from public.listings where title = ${p.copyOf} and array_length(image_paths, 1) > 0
            order by created_at limit 1`;
          const from = src?.image_paths[p.nth ?? 0];
          if (!from) { console.warn(`   (no photo to copy for ${s.key})`); continue; }
          const ext = from.split(".").pop()!;
          const d = dest.replace(/\.jpg$/, `.${ext}`);
          await storageCopy(from, d);
          paths.push(d);
        } else {
          await storagePut(dest, await commonsJpeg(p.commons), "image/jpeg");
          paths.push(dest);
        }
      }
      // Move it to the seller. Seed data skips the human screening hold (the only
      // reviewer is the seller themself, and there's no deployed console yet).
      await sql`update public.listings set seller_id = ${seller}, image_paths = ${paths}, status = 'active' where id = ${j.id}`;
      console.log(`listing ${s.key}: ${j.status}${j.status !== "active" ? " → active" : ""}, ${paths.length} photo(s)`);
    }

    // Record what was made, on the helper, for the cleanup script.
    await fetch(`${BASE}/auth/v1/admin/users/${helper}`, {
      method: "PUT", headers: admin,
      body: JSON.stringify({ app_metadata: { seed: { seller, listings: Object.values(ids), at: started.toISOString() } } }),
    });

    // ── Buyers → completed deals → reviews ────────────────────────────────────
    let n = 0;
    for (const rv of REVIEWS) {
      n++;
      const buyer = await createUser({ email: `seed-buyer-${n}@${SEED_DOMAIN}`, password: pw(), email_confirm: true });
      await sql`
        insert into public.profiles (id, display_name) values (${buyer}, ${rv.name})
        on conflict (id) do update set display_name = excluded.display_name`;
      const listingId = ids[rv.on]!;
      const [l] = await sql<{ price_kobo: string }[]>`select price_kobo from public.listings where id = ${listingId}`;
      const price = Number(l!.price_kobo);
      const g = await createOffer(sql, { listingId, buyerId: buyer, priceKobo: price, qty: 1 });
      if (!g.ok) throw new Error(`offer ${rv.on}: ${g.code}`);
      const deal = g.deal.id;
      const step = async (a: Parameters<typeof transition>[1]) => {
        const r = await transition(sql, a);
        if (!(r as { ok?: boolean }).ok) throw new Error(`${a.action} on ${rv.on}: ${JSON.stringify(r).slice(0, 160)}`);
      };
      await step({ dealId: deal, actor: "SELLER", actorId: seller, action: "accept" });
      await step({ dealId: deal, actor: "BUYER", actorId: buyer, action: "pay" });
      await step({ dealId: deal, actor: "SYSTEM", action: "payment_confirmed", idempotencyKey: `seed:${deal}`, providerRef: `mock_hold_${deal}`, confirmedAmountKobo: price + buyerFeeKobo(price) });
      await step({ dealId: deal, actor: "SELLER", actorId: seller, action: "hand_off" });
      await step({ dealId: deal, actor: "BUYER", actorId: buyer, action: "confirm_receipt" });
      await sql`insert into public.reviews (deal_id, reviewer_id, seller_id, rating, body) values (${deal}, ${buyer}, ${seller}, ${rv.rating}, ${rv.body})`;
      console.log(`review ${n}: ${rv.rating}★ on ${rv.on} by ${rv.name}`);
    }

    // The seed's deal notifications aren't news: mark them read in the in-app list.
    await new Promise((r) => setTimeout(r, 75_000)); // the sweeper relays the outbox within a minute
    const read = await sql`update public.notifications set read_at = now() where user_id = ${seller} and created_at >= ${started} and read_at is null returning id`;
    console.log(`marked ${read.length} seed notification(s) read`);
    console.log("\nDONE ✅");
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
