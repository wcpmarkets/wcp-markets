import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Phase 3 C live — the Vehicles lane on the DEPLOYED API: posting with the full
 * facet set, the catalogue, vehicle filters + sort, price insight, the lead-gen rule
 * (no offers), and logged viewings (propose / confirm / supersede / cancel).
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-vehicles.ts
 *
 * Uses Tata Xenon from the 1980s so live listings can't skew the comparables.
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
const API = process.env.API_URL!.replace(/\/$/, "");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
type U = { id: string; token: string };
async function newUser(tag: string): Promise<U> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}
const j = async <T>(r: Response) => (await r.json()) as T;
const api = (path: string, t: string | null, init: RequestInit = {}) =>
  fetch(`${API}${path}`, { ...init, headers: { ...(t ? H(t) : { "Content-Type": "application/json" }), ...(init.headers ?? {}) } });

type Listing = { id: string; lane: string; condition: string; stock: number; priceKobo: number; attributes: Record<string, unknown> };
type Viewing = { id: string; status: string; proposedBy: string; confirmedAt: string | null; cancelledBy: string | null; startsAt: string };

const car = (over: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) => ({
  lane: "vehicles",
  category: "cars",
  title: "Tata Xenon test",
  priceKobo: 1_000_000_00,
  stock: 5,
  state: "Lagos",
  city: "Yaba",
  attributes: {
    make: "Tata", model: "Xenon", year: 1986, mileageKm: 120_000, transmission: "manual",
    fuel: "diesel", body: "pickup", vehicleCondition: "foreign_used", registration: "registered", ...attrs,
  },
  ...over,
});

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const dealer = await newUser("vh-d");
  const buyer = await newUser("vh-b");
  const other = await newUser("vh-o");
  const users = [dealer, buyer, other];
  const post = (body: unknown) => api("/listings", dealer.token, { method: "POST", body: JSON.stringify(body) });
  try {
    // ── Catalogue ─────────────────────────────────────────────────────────
    console.log("catalogue");
    const cat = await j<{ makes: { make: string; models: { name: string; body: string; fuel: string | null }[] }[]; otherMake: string; maxYear: number }>(await api("/vehicles/catalog", null));
    const corolla = cat.makes.find((m) => m.make === "Toyota")?.models.find((m) => m.name === "Corolla");
    check("catalogue lists Toyota Corolla as a saloon", corolla?.body === "saloon");
    check("…offers an 'Other' make and next year as max", cat.otherMake === "Other" && cat.maxYear === new Date().getUTCFullYear() + 1);

    // ── Posting ───────────────────────────────────────────────────────────
    console.log("posting");
    const r1 = await post(car());
    const A = await j<Listing>(r1);
    check("post a car → 201", r1.status === 201, `${r1.status}`);
    check("lane is vehicles, one unit, condition mirrors used", A.lane === "vehicles" && A.stock === 1 && A.condition === "used", `${A.lane} ${A.stock} ${A.condition}`);
    check("facets round-trip", A.attributes.make === "Tata" && A.attributes.mileageKm === 120_000);
    const bn = await j<Listing>(await post(car({ priceKobo: 1_050_000_00 }, { year: 1987, vehicleCondition: "brand_new", mileageKm: 10 })));
    check("brand-new car gets condition new", bn.condition === "new");
    await post(car({ priceKobo: 950_000_00 }, { year: 1985, mileageKm: 300_000 }));
    const missing = await post(car({}, { mileageKm: undefined }));
    check("missing a facet → 422 vehicle_needs_details", missing.status === 422 && (await j<{ error: string }>(missing)).error === "vehicle_needs_details");
    const badMake = await post(car({}, { make: "Batmobile" }));
    check("unknown make → 422", badMake.status === 422 && (await j<{ error: string }>(badMake)).error === "unknown_make");
    const badYear = await post(car({}, { year: 1960 }));
    check("year before 1980 → 422", badYear.status === 422 && (await j<{ error: string }>(badYear)).error === "invalid_year");
    const otherMake = await post(car({}, { make: "Other", model: "Peugeot 504 Wagon" }));
    check("'Other' make with a free-text model → 201", otherMake.status === 201);

    // ── Filters + sort ────────────────────────────────────────────────────
    console.log("filters");
    const q = "lane=vehicles&make=Tata&model=xenon&minYear=1984&maxYear=1988&state=Lagos&city=Yaba";
    const all = await j<{ items: Listing[] }>(await api(`/listings/search?${q}&sort=price_asc`, null));
    const mineOnly = all.items.filter((i) => [A.id, bn.id].includes(i.id) || i.attributes.make === "Tata");
    check("make/model/year filter finds the three test cars", mineOnly.length === 3, `${mineOnly.length}`);
    const prices = all.items.map((i) => i.priceKobo);
    check("price_asc sorts cheapest first", prices.every((p, i) => i === 0 || prices[i - 1]! <= p));
    const low = await j<{ items: Listing[] }>(await api(`/listings/search?${q}&maxMileageKm=150000&sort=mileage_asc`, null));
    check("maxMileageKm filter + mileage sort", low.items.length === 2 && low.items[0]!.id === bn.id, low.items.map((i) => i.attributes.mileageKm).join(","));
    const newOnly = await j<{ items: Listing[] }>(await api(`/listings/search?${q}&vehicleCondition=brand_new`, null));
    check("condition filter", newOnly.items.length === 1 && newOnly.items[0]!.id === bn.id);
    const auto = await j<{ items: Listing[] }>(await api(`/listings/search?${q}&transmission=automatic`, null));
    check("transmission filter excludes manuals", auto.items.length === 0);

    // ── Price insight ─────────────────────────────────────────────────────
    console.log("price insight");
    type PI = { comparables: number; medianKobo: number | null; verdict: string | null; deltaKobo: number | null };
    const pi = await j<PI>(await api(`/vehicles/price-insight?make=Tata&model=Xenon&year=1986&priceKobo=80000000`, null));
    check("three comparables, median ₦1M", pi.comparables === 3 && pi.medianKobo === 1_000_000_00, JSON.stringify(pi));
    check("₦800k → below, by ₦200k", pi.verdict === "below" && pi.deltaKobo === -200_000_00);
    const fair = await j<PI>(await api(`/vehicles/price-insight?make=Tata&model=Xenon&year=1986&priceKobo=105000000`, null));
    check("within 10% → fair", fair.verdict === "fair");
    const excl = await j<PI>(await api(`/vehicles/price-insight?make=Tata&model=Xenon&year=1986&priceKobo=105000000&excludeListingId=${A.id}`, null));
    check("excluding the viewed listing leaves too few → no verdict", excl.comparables === 2 && excl.verdict === null && excl.medianKobo === null);

    // ── Lead-gen: no offers ───────────────────────────────────────────────
    console.log("lead-gen");
    const offer = await api(`/listings/${A.id}/offers`, buyer.token, { method: "POST", body: JSON.stringify({ priceKobo: 900_000_00 }) });
    check("an offer on a car → 409 lead_gen_lane", offer.status === 409 && (await j<{ error: string }>(offer)).error === "lead_gen_lane", `${offer.status}`);
    const convR = await api(`/listings/${A.id}/conversations`, buyer.token, { method: "POST" });
    const conv = await j<{ id: string; viewing: unknown }>(convR);
    check("enquiry opens a chat", convR.status === 200 || convR.status === 201, `${convR.status}`);
    check("…with no viewing yet", conv.viewing == null);

    // ── Viewings ──────────────────────────────────────────────────────────
    console.log("viewings");
    const at = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    const propose = (t: string, body: Record<string, unknown>) =>
      api(`/conversations/${conv.id}/viewings`, t, { method: "POST", body: JSON.stringify(body) });
    const past = await propose(buyer.token, { startsAt: at(-1), place: "Yaba" });
    check("time in the past → 422", past.status === 422);
    const far = await propose(buyer.token, { startsAt: at(24 * 100), place: "Yaba" });
    check("more than 90 days ahead → 422", far.status === 422);
    const win = await propose(buyer.token, { startsAt: at(24), endsAt: at(40), place: "Yaba" });
    check("window over 12h → 422", win.status === 422);
    check("non-party → 404", (await propose(other.token, { startsAt: at(24), place: "Yaba" })).status === 404);
    const v1r = await propose(buyer.token, { startsAt: at(24), endsAt: at(26), place: "Dealer lot, 12 Herbert Macaulay Way", note: "Bringing my mechanic" });
    const v1 = await j<Viewing>(v1r);
    check("buyer proposes → 201 proposed", v1r.status === 201 && v1.status === "proposed", `${v1r.status}`);
    const dealerInbox = await j<{ items: { id: string }[] }>(await api("/conversations", dealer.token));
    check("a viewing alone lifts the thread into the dealer's inbox", dealerInbox.items.some((i) => i.id === conv.id));
    check("proposer can't confirm their own", (await api(`/viewings/${v1.id}/confirm`, buyer.token, { method: "POST" })).status === 403);
    const v2r = await propose(dealer.token, { startsAt: at(48), place: "Dealer lot" });
    const v2 = await j<Viewing>(v2r);
    check("dealer counter-proposes → 201", v2r.status === 201);
    const hist = await j<Viewing[]>(await api(`/conversations/${conv.id}/viewings`, buyer.token));
    check("the first is superseded", hist.find((h) => h.id === v1.id)?.status === "superseded" && hist[0]!.id === v2.id);
    check("can't confirm a superseded one", (await api(`/viewings/${v1.id}/confirm`, dealer.token, { method: "POST" })).status === 409);
    const conf = await api(`/viewings/${v2.id}/confirm`, buyer.token, { method: "POST" });
    const confV = await j<Viewing>(conf);
    check("buyer confirms the dealer's → confirmed, stamped", conf.status === 200 && confV.status === "confirmed" && !!confV.confirmedAt);
    const inbox = await j<{ id: string; viewing: Viewing | null }>(await api(`/conversations/${conv.id}`, dealer.token));
    check("conversation carries the live viewing", inbox.viewing?.id === v2.id && inbox.viewing.status === "confirmed");
    const can = await api(`/viewings/${v2.id}/cancel`, dealer.token, { method: "POST" });
    const canV = await j<Viewing>(can);
    check("dealer cancels → cancelled, by dealer", can.status === 200 && canV.status === "cancelled" && canV.cancelledBy === dealer.id);
    check("cancel again → 409", (await api(`/viewings/${v2.id}/cancel`, buyer.token, { method: "POST" })).status === 409);
    check("outsider cancel → 404", (await api(`/viewings/${v1.id}/cancel`, other.token, { method: "POST" })).status === 404);
    const after = await j<{ viewing: Viewing | null }>(await api(`/conversations/${conv.id}`, buyer.token));
    check("no live viewing after cancel", after.viewing == null);
    await api(`/users/${dealer.id}/block`, buyer.token, { method: "PUT" });
    const blocked = await propose(dealer.token, { startsAt: at(24), place: "Lot" });
    check("blocked → 403", blocked.status === 403, `${blocked.status}`);
    let dbErr = "";
    try { await sql`insert into public.viewings (conversation_id, proposed_by, starts_at, place, status) values (${conv.id}, ${buyer.id}, now(), 'x', 'confirmed')`; } catch (e) { dbErr = (e as Error).message; }
    check("DB refuses a confirmed viewing without a stamp", dbErr.includes("viewings_confirmed"), dbErr.slice(0, 60));
  } finally {
    await sql`delete from public.listings where seller_id = ${dealer.id}`;
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ vehicles lane + viewings work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
