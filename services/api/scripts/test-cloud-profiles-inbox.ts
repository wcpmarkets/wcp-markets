import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Phase 3 A live — profiles, addresses, blocking, public seller profile, and the
 * conversation inbox on the DEPLOYED API (plus RLS on the direct read path).
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-profiles-inbox.ts
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
// The PUBLIC anon/publishable key (the one the apps embed) — RLS checks act as a client.
const ANON = process.env.SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
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

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("pi-s");
  const buyer = await newUser("pi-b");
  const other = await newUser("pi-o");
  try {
    // ── Profile ───────────────────────────────────────────────────────────
    console.log("profile");
    const me0 = await j<Record<string, any>>(await api("/me", seller.token));
    check("GET /me returns default prefs", me0.notificationPrefs?.channels?.push === true && me0.notificationPrefs?.topics?.promotions === false);
    const pr = await api("/me", seller.token, { method: "PATCH", body: JSON.stringify({ displayName: "Dami Test", storeName: "Dami's Test Gadgets", bio: "Tested before you pay.", state: "Lagos", city: "Yaba", notificationPrefs: { channels: { whatsapp: true } } }) });
    const me1 = await j<Record<string, any>>(pr);
    check("PATCH /me → 200 with new fields", pr.status === 200 && me1.storeName === "Dami's Test Gadgets" && me1.city === "Yaba", `${pr.status}`);
    check("prefs merge is partial (whatsapp on, push kept)", me1.notificationPrefs.channels.whatsapp === true && me1.notificationPrefs.channels.push === true);
    check("invalid area → 400", (await api("/me", seller.token, { method: "PATCH", body: JSON.stringify({ state: "Lagos", city: "Atlantis" }) })).status === 400);
    check("city without state → 400", (await api("/me", seller.token, { method: "PATCH", body: JSON.stringify({ state: null, city: "Yaba" }) })).status === 400);

    const av = await j<{ uploadUrl: string }>(await api("/me/avatar", seller.token, { method: "POST", body: JSON.stringify({ contentType: "image/png" }) }));
    // 1×1 PNG
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
    const put = await fetch(av.uploadUrl, { method: "PUT", headers: { "Content-Type": "image/png" }, body: png });
    check("avatar upload PUT ok", put.ok, `${put.status}`);
    const me2 = await j<{ avatarUrl: string | null }>(await api("/me", seller.token));
    check("avatarUrl signed + fetchable", !!me2.avatarUrl && (await fetch(me2.avatarUrl!)).ok);

    const pub = await j<Record<string, unknown>>(await api(`/users/${seller.id}`, null));
    check("public profile has store name, no phone", pub.storeName === "Dami's Test Gadgets" && !("phone" in pub));
    check("public profile counts start at 0", pub.salesCount === 0 && pub.reviewCount === 0);

    // ── Addresses ─────────────────────────────────────────────────────────
    console.log("addresses");
    const a1 = await j<{ id: string; isDefault: boolean }>(await api("/me/addresses", buyer.token, { method: "POST", body: JSON.stringify({ label: "Home", line: "12 Herbert Macaulay Way", state: "Lagos", city: "Yaba" }) }));
    check("first address becomes default", a1.isDefault === true);
    const a2 = await j<{ id: string; isDefault: boolean }>(await api("/me/addresses", buyer.token, { method: "POST", body: JSON.stringify({ label: "Office", line: "4 Adeola Odeku St", isDefault: true }) }));
    let list = await j<{ id: string; isDefault: boolean }[]>(await api("/me/addresses", buyer.token));
    check("making #2 default unsets #1", list.filter((a) => a.isDefault).length === 1 && list[0]!.id === a2.id);
    check("other user cannot edit it → 404", (await api(`/me/addresses/${a2.id}`, other.token, { method: "PATCH", body: JSON.stringify({ label: "x" }) })).status === 404);
    await api(`/me/addresses/${a2.id}`, buyer.token, { method: "DELETE" });
    list = await j<{ id: string; isDefault: boolean }[]>(await api("/me/addresses", buyer.token));
    check("deleting the default promotes the remaining one", list.length === 1 && list[0]!.id === a1.id && list[0]!.isDefault);

    // ── Listing carries the seller summary ────────────────────────────────
    const lr = await api("/listings", seller.token, { method: "POST", body: JSON.stringify({ category: "phones", title: "pi phone", priceKobo: 10_000_000, stock: 2, state: "Lagos", city: "Yaba" }) });
    const listing = await j<{ id: string; seller: { storeName: string | null; verified: boolean } }>(lr);
    check("listing.seller.storeName present", listing.seller?.storeName === "Dami's Test Gadgets", JSON.stringify(listing.seller));

    // ── Conversations ─────────────────────────────────────────────────────
    console.log("conversations");
    const c1r = await api(`/listings/${listing.id}/conversations`, buyer.token, { method: "POST" });
    const conv = await j<{ id: string; role: string; counterpart: { storeName: string } }>(c1r);
    check("open conversation → 201, buyer role, counterpart named", c1r.status === 201 && conv.role === "buyer" && conv.counterpart.storeName === "Dami's Test Gadgets", `${c1r.status}`);
    const c2r = await api(`/listings/${listing.id}/conversations`, buyer.token, { method: "POST" });
    check("re-open → 200 same id", c2r.status === 200 && (await j<{ id: string }>(c2r)).id === conv.id);
    check("own listing → 403", (await api(`/listings/${listing.id}/conversations`, seller.token, { method: "POST" })).status === 403);
    check("empty thread hidden from inbox", (await j<{ items: unknown[] }>(await api("/conversations", seller.token))).items.length === 0);

    const sent = await api(`/conversations/${conv.id}/messages`, buyer.token, { method: "POST", body: JSON.stringify({ body: "Is it still available?" }) });
    check("buyer sends pre-offer message → 201, no deal yet", sent.status === 201 && (await j<{ dealId: string | null }>(sent)).dealId === null);
    let inbox = await j<{ items: { id: string; unreadCount: number; role: string; lastMessage: { body: string } }[]; unreadConversations: number }>(await api("/conversations", seller.token));
    check("seller inbox: 1 row, unread 1, role seller", inbox.items.length === 1 && inbox.items[0]!.unreadCount === 1 && inbox.items[0]!.role === "seller" && inbox.unreadConversations === 1);
    check("filter=buying hides it for the seller", (await j<{ items: unknown[] }>(await api("/conversations?filter=buying", seller.token))).items.length === 0);
    check("non-party → 404", (await api(`/conversations/${conv.id}/messages`, other.token)).status === 404);
    await api(`/conversations/${conv.id}/read`, seller.token, { method: "POST" });
    inbox = await j(await api("/conversations?filter=unread", seller.token));
    check("after read: unread filter empty", inbox.items.length === 0 && inbox.unreadConversations === 0);

    // An offer joins the same thread; later messages are stamped with the deal.
    const deal = await j<{ id: string }>(await api(`/listings/${listing.id}/offers`, buyer.token, { method: "POST", body: JSON.stringify({ priceKobo: 9_500_000 }) }));
    const dm = await j<{ body: string }[]>(await api(`/deals/${deal.id}/messages`, seller.token));
    check("deal chat includes the pre-offer message", dm.some((m) => m.body === "Is it still available?"));
    const after = await j<{ dealId: string | null }>(await api(`/conversations/${conv.id}/messages`, seller.token, { method: "POST", body: JSON.stringify({ body: "Yes — offer received." }) }));
    check("message after the offer is stamped with the deal (realtime compat)", after.dealId === deal.id);
    const viaDeal = await api(`/deals/${deal.id}/messages`, buyer.token, { method: "POST", body: JSON.stringify({ body: "Great" }) });
    check("legacy deal-chat send still works", viaDeal.status === 201);
    const row = await j<{ deal: { id: string; state: string } | null; lastMessage: { body: string } }>(await api(`/conversations/${conv.id}`, buyer.token));
    check("conversation pins the deal state + last message", row.deal?.id === deal.id && row.deal?.state === "OFFERED" && row.lastMessage.body === "Great");

    // ── Blocking ──────────────────────────────────────────────────────────
    console.log("blocking");
    check("block → 204", (await api(`/users/${buyer.id}/block`, seller.token, { method: "PUT" })).status === 204);
    check("blocked buyer can't message → 403", (await api(`/conversations/${conv.id}/messages`, buyer.token, { method: "POST", body: JSON.stringify({ body: "hello?" }) })).status === 403);
    check("blocked buyer can't make an offer → 403", (await api(`/listings/${listing.id}/offers`, buyer.token, { method: "POST", body: JSON.stringify({ priceKobo: 9_000_000 }) })).status === 403);
    await api(`/users/${other.id}/block`, seller.token, { method: "PUT" });
    check("a blocked stranger can't open a conversation → 403", (await api(`/listings/${listing.id}/conversations`, other.token, { method: "POST" })).status === 403);
    const blocks = await j<{ id: string }[]>(await api("/me/blocks", seller.token));
    check("GET /me/blocks lists both", blocks.length === 2);
    check("public profile shows blockedByMe for the blocker", (await j<{ blockedByMe: boolean }>(await api(`/users/${buyer.id}`, seller.token))).blockedByMe === true);
    await api(`/users/${buyer.id}/block`, seller.token, { method: "DELETE" });
    check("after unblock the buyer can message again", (await api(`/conversations/${conv.id}/messages`, buyer.token, { method: "POST", body: JSON.stringify({ body: "thanks" }) })).status === 201);

    // ── RLS on the direct read path ───────────────────────────────────────
    if (ANON) {
      console.log("rls");
      const rest = (t: string, q: string) => fetch(`${BASE}/rest/v1/${q}`, { headers: { apikey: ANON, Authorization: `Bearer ${t}` } }).then((r) => r.json() as Promise<unknown[]>);
      check("buyer reads own conversation via PostgREST", (await rest(buyer.token, `conversations?id=eq.${conv.id}`)).length === 1);
      check("stranger reads none of its messages", (await rest(other.token, `messages?conversation_id=eq.${conv.id}`)).length === 0);
      check("stranger can't read others' addresses", (await rest(other.token, `addresses?user_id=eq.${buyer.id}`)).length === 0);
      const w = await fetch(`${BASE}/rest/v1/messages`, { method: "POST", headers: { apikey: ANON, Authorization: `Bearer ${buyer.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ conversation_id: conv.id, sender_id: buyer.id, body: "direct" }) });
      check("client can't write messages directly", !w.ok, `${w.status}`);
    } else {
      console.log("   (skipping RLS checks — no anon/publishable key in .env.local)");
    }
  } finally {
    await sql`delete from public.outbox where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deal_deadlines where deal_id in (select id from public.deals where seller_id = ${seller.id})`;
    await sql`delete from public.deals where seller_id = ${seller.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of [seller, buyer, other]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ profiles + inbox work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
