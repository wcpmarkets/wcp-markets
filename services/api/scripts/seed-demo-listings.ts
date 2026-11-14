import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Seed a handful of realistic Goods listings against the DEPLOYED API so the mobile
 * clients have something real to render. Creates a dedicated demo seller via the
 * Supabase admin API, then POSTs listings through the WCP API like any client would
 * (contract-validated). Non-destructive: leaves existing data alone. Re-runnable —
 * each run makes a fresh demo seller, and GET /listings is newest-first so the seed
 * leads the feed.
 *
 *   API_URL=https://a33kb0enoa.execute-api.eu-west-1.amazonaws.com \
 *     node --import tsx services/api/scripts/seed-demo-listings.ts
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
const API = process.env.API_URL ?? "https://a33kb0enoa.execute-api.eu-west-1.amazonaws.com";
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const naira = (n: number) => n * 100;

type Seed = {
  category: string; title: string; description: string; priceKobo: number;
  condition: "new" | "used" | "refurbished"; negotiable: boolean; stock: number; location: string;
};
const LISTINGS: Seed[] = [
  { category: "phones", title: "iPhone 13 Pro — 128GB, Graphite", description: "Clean UK-used, battery health 89%, no scratches. Comes with box and cable.", priceKobo: naira(520_000), condition: "used", negotiable: true, stock: 1, location: "Ikeja, Lagos" },
  { category: "gaming", title: "Sony PlayStation 5 Slim (Disc)", description: "Brand new, sealed. Includes one DualSense controller.", priceKobo: naira(780_000), condition: "new", negotiable: false, stock: 3, location: "Lekki, Lagos" },
  { category: "laptops", title: "HP EliteBook 840 G8 — i7, 16GB", description: "Refurbished, 512GB SSD, Windows 11. Great for work and school.", priceKobo: naira(610_000), condition: "refurbished", negotiable: true, stock: 2, location: "Wuse, Abuja" },
  { category: "tv-audio", title: 'Samsung 55" QLED 4K Smart TV', description: "Used for 8 months, perfect picture. Wall bracket included.", priceKobo: naira(430_000), condition: "used", negotiable: true, stock: 1, location: "GRA, Port Harcourt" },
  { category: "computers", title: 'Dell UltraSharp 27" 4K Monitor', description: "New in box, USB-C, factory-calibrated colour.", priceKobo: naira(295_000), condition: "new", negotiable: false, stock: 4, location: "Bodija, Ibadan" },
  { category: "gaming", title: "Nintendo Switch OLED — White", description: "Lightly used, screen protector on since day one. All accessories.", priceKobo: naira(210_000), condition: "used", negotiable: true, stock: 1, location: "Yaba, Lagos" },
];

async function main() {
  const tag = Date.now();
  const email = `demo-seller+${tag}@wcp-demo.local`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ email, password: `WcpDemo-${tag}9x!`, email_confirm: true }),
  });
  if (!cr.ok) throw new Error(`create seller failed: ${cr.status} ${await cr.text()}`);
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `WcpDemo-${tag}9x!` }),
  });
  const token = ((await si.json()) as { access_token: string }).access_token;
  console.log(`demo seller ${id} (${email})`);

  let ok = 0;
  for (const l of LISTINGS) {
    const r = await fetch(`${API}/listings`, { method: "POST", headers: H(token), body: JSON.stringify({ ...l, attributes: { delivery: { modes: ["deliver", "meet"] } } }) });
    if (r.ok) { ok++; console.log(`  ✓ ${l.title}`); }
    else console.log(`  ✗ ${l.title} — ${r.status} ${await r.text()}`);
  }
  console.log(`\nseeded ${ok}/${LISTINGS.length} listings. GET ${API}/listings now leads with these.`);
  process.exit(ok === LISTINGS.length ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
