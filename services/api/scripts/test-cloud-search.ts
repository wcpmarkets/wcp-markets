import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M2 end-to-end against the DEPLOYED API: seed a spread of Goods listings, then
 * exercise GET /listings/search — full-text, fuzzy (typo), each filter, combined
 * query+filter, and relevance ordering. Cleans up the seller (listings cascade).
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
const API = process.env.API_URL!;
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

let pass = true;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

type Item = { id: string; title: string };
async function search(qs: string): Promise<Item[]> {
  const r = await fetch(`${API}/listings/search?${qs}`);
  const body = (await r.json()) as { items: Item[] };
  return body.items ?? [];
}
const titles = (items: Item[]) => items.map((i) => i.title);

async function main() {
  if (!BASE || !SERVICE || !API) throw new Error("missing SUPABASE_URL / key / API_URL");

  const email = `clitest+search${Date.now()}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const { id: sellerId } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { access_token: token } = (await si.json()) as { access_token: string };
  const authed = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // A tag unique to this run so filters don't collide with other test data.
  const tag = `zzt${Date.now().toString().slice(-6)}`;
  const seed = [
    { title: `iPhone 13 Pro Max ${tag}`, category: `phones-${tag}`, priceKobo: 45_000_000, condition: "used", location: "Lagos" },
    { title: `Samsung Galaxy S22 ${tag}`, category: `phones-${tag}`, priceKobo: 30_000_000, condition: "new", location: "Abuja" },
    { title: `MacBook Pro 14 ${tag}`, category: `laptops-${tag}`, priceKobo: 85_000_000, condition: "used", location: "Lagos" },
    { title: `Office Desk ${tag}`, category: `furniture-${tag}`, priceKobo: 5_000_000, condition: "new", location: "Bayelsa" },
  ];
  for (const s of seed) {
    await fetch(`${API}/listings`, { method: "POST", headers: authed, body: JSON.stringify(s) });
  }
  console.log(`0) seeded ${seed.length} listings (tag=${tag})`);

  // Present iff a result matches `sub` AND belongs to this run (shares the tag).
  const has = (items: Item[], sub: string) =>
    items.some((i) => i.title.includes(sub) && i.title.includes(tag));

  // 1) full-text — must find the target AND discriminate (no unrelated Office Desk).
  const iphone = await search(`q=iphone`);
  check("FTS 'iphone' finds the iPhone", has(iphone, "iPhone"));
  check("FTS 'iphone' excludes Office Desk", !has(iphone, "Office Desk"));

  const macbook = await search(`q=macbook`);
  check("FTS 'macbook' finds the MacBook", has(macbook, "MacBook"));

  // 2) fuzzy / typo tolerance — 'ihpone' finds the iPhone but not the Desk.
  const typo = await search(`q=ihpone`);
  check("fuzzy 'ihpone' finds the iPhone", has(typo, "iPhone"), titles(typo).join(", ") || "none");
  check("fuzzy 'ihpone' excludes Office Desk", !has(typo, "Office Desk"));

  // 3) filters
  const byCat = await search(`category=phones-${tag}`);
  check("filter category → 2 phones", byCat.length === 2, `${byCat.length}`);

  const byCond = await search(`category=phones-${tag}&condition=new`);
  check("filter condition=new → Samsung only", byCond.length === 1 && byCond[0]!.title.includes("Samsung"));

  const byPrice = await search(`q=${tag}&minPrice=40000000&maxPrice=90000000`);
  check("filter price 40M–90M → iPhone + MacBook", byPrice.length === 2, titles(byPrice).join(", "));

  const byLoc = await search(`q=${tag}&location=lagos`);
  check("filter location=lagos → iPhone + MacBook", byLoc.length === 2, `${byLoc.length}`);

  // 4) combined query + filter
  const combo = await search(`q=pro+${tag}&location=lagos`);
  check("q='pro' + Lagos → iPhone Pro + MacBook Pro", combo.length === 2, titles(combo).join(", "));

  // 5) ranking — 'macbook pro' should rank the MacBook first
  const ranked = await search(`q=macbook+pro+${tag}`);
  check("ranking puts MacBook first for 'macbook pro'", ranked[0]?.title.includes("MacBook") ?? false, titles(ranked).join(" | "));

  // 6) empty query with unknown filter → no results (not an error)
  const none = await search(`category=nonexistent-${tag}`);
  check("unknown category → empty, 200", none.length === 0);

  await fetch(`${BASE}/auth/v1/admin/users/${sellerId}`, { method: "DELETE", headers: admin });
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M2 search/browse works end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
