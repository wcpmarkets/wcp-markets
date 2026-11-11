import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Saved & watches on the DEPLOYED API (0036) — design 20k / 21a / 20l Deals ✦.
 *
 *   A. saved: ♡ remembers the price; a drop pushes "Price drop: ₦85,000 … ↓ ₦15,000 since
 *      you saved it"; a rise doesn't.
 *   B. watch: made with a ceiling, it shows what already matches (not pushed); a new
 *      listing above the ceiling isn't caught, re-priced under it is — once, pushed
 *      "Watch caught one: …"; the market min ignores the ceiling; dismiss hides it.
 *   C. the in-app list carries listingId under topic 'watch'.
 *   D. never your own listing; a switched-off watch catches nothing; delete stops it.
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
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`);
};
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const users: string[] = [];

async function newUser(tag: string, name: string) {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const { id } = (await (await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  users.push(id);
  const token = ((await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()) as { access_token: string }).access_token;
  await fetch(`${API}/me`, { method: "PATCH", headers: H(token), body: JSON.stringify({ displayName: name }) });
  return { id, token };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const note = async (key: string, waitMs = 25_000) => {
    const t0 = Date.now();
    for (;;) {
      const [n] = await sql<{ title: string; body: string; status: string; topic: string; data: Record<string, string> }[]>`
        select title, body, status, topic, data from public.notifications where dedupe_key = ${key} and status <> 'pending'`;
      if (n || Date.now() - t0 > waitMs) return n;
      await sleep(500);
    }
  };
  const listing = async (t: string, title: string, priceKobo: number) =>
    ((await (await fetch(`${API}/listings`, { method: "POST", headers: H(t), body: JSON.stringify({ category: "phones", title, priceKobo, stock: 1 }) })).json()) as { id: string }).id;
  const reprice = (t: string, id: string, priceKobo: number) =>
    fetch(`${API}/listings/${id}`, { method: "PATCH", headers: H(t), body: JSON.stringify({ priceKobo }) });

  try {
    const seller = await newUser("watch-s-", "Watch Test Seller");
    const buyer = await newUser("watch-b-", "Watch Test Buyer");
    const word = `zq${Math.random().toString(36).slice(2, 8)}`; // matches only this test's listings

    console.log("A. saved + price drop");
    const l1 = await listing(seller.token, `Watch test sofa ${word}`, 10_000_000);
    check("save → 200", (await fetch(`${API}/me/saved/${l1}`, { method: "PUT", headers: H(buyer.token) })).status === 200);
    check("save again is fine", (await fetch(`${API}/me/saved/${l1}`, { method: "PUT", headers: H(buyer.token) })).status === 200);
    const ids = (await (await fetch(`${API}/me/saved/ids`, { headers: H(buyer.token) })).json()) as { ids: string[] };
    check("in my ids", ids.ids.includes(l1));
    await reprice(seller.token, l1, 8_500_000);
    const drop = await note(`drop:${l1}:8500000:${buyer.id}`);
    check("saver told of the drop", drop?.title === "Price drop: ₦85,000", JSON.stringify(drop?.title));
    check("…by how much since saved", !!drop?.body.includes("↓ ₦15,000 since you saved it"), drop?.body);
    check("topic watch, opens the listing", drop?.topic === "watch" && drop.data.listingId === l1);
    const saved = (await (await fetch(`${API}/me/saved`, { headers: H(buyer.token) })).json()) as { items: { listing: { id: string }; changeKobo: number; priceAtSaveKobo: number }[] };
    const s1 = saved.items.find((i) => i.listing.id === l1);
    check("saved list: ↓ ₦15k since saved", s1?.priceAtSaveKobo === 10_000_000 && s1.changeKobo === -1_500_000, JSON.stringify(s1 && { at: s1.priceAtSaveKobo, ch: s1.changeKobo }));
    await reprice(seller.token, l1, 9_000_000);
    await sleep(4000);
    const [rise] = await sql`select 1 from public.notifications where dedupe_key = ${`drop:${l1}:9000000:${buyer.id}`}`;
    check("a rise isn't pushed", !rise);

    console.log("B. watch");
    const pre = await listing(seller.token, `Tecno Spark ${word} early`, 4_000_000); // already there, under the ceiling
    const wr = await fetch(`${API}/me/watches`, {
      method: "POST",
      headers: H(buyer.token),
      body: JSON.stringify({ label: `Tecno Spark ${word} under ₦50k`, lane: "goods", keywords: word, filters: { category: "phones" }, ceilingKobo: 5_000_000 }),
    });
    const w = (await wr.json()) as { id: string; hits: { listing: { id: string } }[]; ceilingKobo: number };
    check("watch → 201", wr.status === 201 && w.ceilingKobo === 5_000_000, `${wr.status}`);
    check("shows what already matches", w.hits.some((h) => h.listing.id === pre));
    await sleep(2500);
    const [prePush] = await sql`select 1 from public.notifications where dedupe_key = ${`watch:${w.id}:${pre}`}`;
    check("…without pushing it", !prePush);
    const l2 = await listing(seller.token, `Tecno Spark ${word} new`, 6_000_000);
    await sleep(4000);
    const [above] = await sql`select 1 from public.watch_hits where watch_id = ${w.id} and listing_id = ${l2}`;
    check("above the ceiling: not caught", !above);
    await reprice(seller.token, l2, 4_500_000);
    const caught = await note(`watch:${w.id}:${l2}`);
    check("re-priced under: caught + pushed", !!caught?.title.startsWith("Watch caught one:") && caught.title.includes("₦45,000"), caught?.title);
    check("…₦5k under your ceiling", !!caught?.body.includes("₦5,000 under your ceiling"), caught?.body);
    await reprice(seller.token, l2, 4_400_000);
    await sleep(4000);
    const [{ n: hitsN }] = (await sql<{ n: number }[]>`select count(*)::int as n from public.watch_hits where watch_id = ${w.id} and listing_id = ${l2}`) as unknown as [{ n: number }];
    check("caught once, not on every wobble", hitsN === 1);
    const list = (await (await fetch(`${API}/me/watches`, { headers: H(buyer.token) })).json()) as { items: { id: string; hits: { listing: { id: string }; underKobo: number | null }[]; marketCount: number; marketMinKobo: number | null }[] };
    const mine = list.items.find((x) => x.id === w.id);
    check("listed with both hits", mine?.hits.length === 2, `${mine?.hits.length}`);
    check("market ignores the ceiling (the sofa shares the token)", mine?.marketCount === 3 && mine.marketMinKobo === 4_000_000, JSON.stringify(mine && { n: mine.marketCount, min: mine.marketMinKobo }));
    const dis = await fetch(`${API}/me/watches/${w.id}/dismiss`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ listingId: l2 }) });
    const after = (await (await fetch(`${API}/me/watches`, { headers: H(buyer.token) })).json()) as typeof list;
    check("dismiss hides it", dis.status === 204 && !after.items.find((x) => x.id === w.id)?.hits.some((h) => h.listing.id === l2));

    const pz = await fetch(`${API}/me/watches/${w.id}`, { method: "PATCH", headers: H(buyer.token), body: JSON.stringify({ paused: true }) });
    check("switch off → paused", pz.status === 200 && ((await pz.json()) as { paused: boolean }).paused === true);
    const l3 = await listing(seller.token, `Tecno Spark ${word} quiet`, 3_000_000);
    await sleep(4000);
    const [quiet] = await sql`select 1 from public.watch_hits where watch_id = ${w.id} and listing_id = ${l3}`;
    check("a paused watch catches nothing new", !quiet);

    console.log("C. in-app list");
    const page = (await (await fetch(`${API}/me/notifications?topic=watch`, { headers: H(buyer.token) })).json()) as { items: { topic: string; listingId: string | null; title: string }[] };
    check("Deals ✦ lists both, each with its listing", page.items.length === 2 && page.items.every((i) => i.topic === "watch" && !!i.listingId), page.items.map((i) => i.title).join(" | "));

    console.log("D. own listings, delete");
    const ownW = (await (await fetch(`${API}/me/watches`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ label: "own", keywords: word, filters: { category: "phones" } }) })).json()) as { hits: unknown[] };
    check("a seller's watch never shows their own listings", ownW.hits.length === 0);
    check("delete → 204", (await fetch(`${API}/me/watches/${w.id}`, { method: "DELETE", headers: H(buyer.token) })).status === 204);
    const gone = (await (await fetch(`${API}/me/watches`, { headers: H(buyer.token) })).json()) as typeof list;
    check("gone", !gone.items.some((x) => x.id === w.id));
    check("unsave → gone", (await fetch(`${API}/me/saved/${l1}`, { method: "DELETE", headers: H(buyer.token) })).status === 200);
  } finally {
    await sql.end();
    for (const id of users) await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
  }
  console.log(pass ? "VERDICT → PASS ✅ saved & watches (deployed)" : "VERDICT → FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
