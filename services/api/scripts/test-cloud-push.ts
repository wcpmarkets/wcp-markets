import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Push notifications on the DEPLOYED API (0033).
 *
 *   A. devices: register → 200; a revoked sign-in drops its device (FK to auth.sessions);
 *      remove → gone.
 *   B. an offer → the seller gets "New offer: ₦8,000", within seconds (the API relays
 *      the outbox right after the write; the sweeper alone would take up to a minute).
 *   C. a chat message → the other party, titled with the sender's name.
 *   D. preferences: messages switched off → the next one is logged 'skipped'.
 *
 * Without FCM credentials in SSM a decided push is logged 'mocked'; with them, the fake
 * tokens here are rejected by FCM ('failed') and dropped. Both count as delivered-to-FCM-
 * layer for this test — the device test covers a real phone.
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

async function newUser(tag: string, name: string) {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const { id } = (await (await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  const signIn = async () =>
    ((await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()) as { access_token: string }).access_token;
  const token = await signIn();
  await fetch(`${API}/me`, { method: "PATCH", headers: H(token), body: JSON.stringify({ displayName: name }) });
  return { id, token, signIn };
}
const fakeToken = (tag: string) => `test-${tag}-${Date.now()}-${"x".repeat(40)}`;

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const note = async (key: string, waitMs = 30_000) => {
    const t0 = Date.now();
    for (;;) {
      const [n] = await sql<{ title: string; body: string; status: string; detail: string | null; data: Record<string, string> }[]>`
        select title, body, status, detail, data from public.notifications where dedupe_key = ${key} and status <> 'pending'`;
      if (n || Date.now() - t0 > waitMs) return { n, ms: Date.now() - t0 };
      await sleep(500);
    }
  };
  const put = (t: string, token: string) => fetch(`${API}/me/push-devices`, { method: "PUT", headers: H(t), body: JSON.stringify({ token, platform: "android" }) });
  try {
    const seller = await newUser("push-s-", "Push Test Seller");
    const buyer = await newUser("push-b-", "Push Test Buyer");

    console.log("A. devices");
    const sTok = fakeToken("s");
    check("register → 200", (await put(seller.token, sTok)).status === 200);
    check("bad body → 400", (await fetch(`${API}/me/push-devices`, { method: "PUT", headers: H(seller.token), body: JSON.stringify({ token: "short", platform: "android" }) })).status === 400);
    // A second sign-in for the buyer: register under it, then revoke it from the first.
    const buyer2 = await buyer.signIn();
    const oldTok = fakeToken("b-old");
    check("register under a second sign-in", (await put(buyer2, oldTok)).status === 200);
    const so = await fetch(`${API}/me/sessions/sign-out-others`, { method: "POST", headers: H(buyer.token) });
    const [left] = await sql`select 1 from public.push_devices where token = ${oldTok}`;
    check("sign out other devices drops that device", so.status === 200 && !left, `${so.status}`);
    const bTok = fakeToken("b");
    await put(buyer.token, bTok);
    const rm = await fetch(`${API}/me/push-devices/remove`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ token: bTok }) });
    const [still] = await sql`select 1 from public.push_devices where token = ${bTok}`;
    check("remove → gone", rm.status === 200 && !still);
    await put(buyer.token, bTok);

    console.log("B. offer → seller");
    const listing = (await (await fetch(`${API}/listings`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ attributes: { delivery: { modes: ["meet"] } }, category: "phones", title: "Push test — Tecno Spark", priceKobo: 800_000, stock: 1 }) })).json()) as { id: string };
    const deal = (await (await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: 800_000 }) })).json()) as { id: string };
    const offer = await note(`deal:${deal.id}:1:seller`);
    check("seller told of the offer", offer.n?.title === "New offer: ₦8,000", JSON.stringify(offer.n?.title));
    check("body names the buyer and item", !!offer.n?.body.includes("Push Test Buyer") && offer.n.body.includes("Push test — Tecno Spark"), offer.n?.body);
    check("delivered to the push layer", ["mocked", "sent", "failed"].includes(offer.n?.status ?? ""), `${offer.n?.status} ${offer.n?.detail ?? ""}`);
    check(`within seconds, not the sweeper's minute (${offer.ms}ms)`, offer.ms < 20_000);
    check("carries the deal for the app to open", offer.n?.data.type === "deal" && offer.n?.data.dealId === deal.id);

    console.log("C. message → other party");
    await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ action: "accept" }) });
    const acc = await note(`deal:${deal.id}:2:buyer`);
    check("buyer told the offer was accepted", acc.n?.title === "Offer accepted — pay to secure it", JSON.stringify(acc.n?.title));
    const m1 = (await (await fetch(`${API}/deals/${deal.id}/messages`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ body: "Is it still sealed?" }) })).json()) as { id: number };
    const msg = await note(`msg:${m1.id}`);
    check("seller gets the message, titled with the sender", msg.n?.title === "Push Test Buyer" && msg.n.body === "Is it still sealed?", JSON.stringify(msg.n));
    check("opens the conversation", msg.n?.data.type === "conversation" && !!msg.n?.data.conversationId);

    console.log("D. preferences");
    await fetch(`${API}/me`, { method: "PATCH", headers: H(seller.token), body: JSON.stringify({ notificationPrefs: { topics: { messages: false } } }) });
    const m2 = (await (await fetch(`${API}/deals/${deal.id}/messages`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ body: "Hello?" }) })).json()) as { id: number };
    const muted = await note(`msg:${m2.id}`);
    check("messages off → skipped", muted.n?.status === "skipped", `${muted.n?.status}`);

    console.log("E. the in-app list (20l)");
    type Page = { items: { id: number; topic: string; title: string; conversationId: string | null; dealId: string | null; read: boolean }[]; unread: number; nextBefore: number | null };
    const list = async (q = "") => (await (await fetch(`${API}/me/notifications${q}`, { headers: H(seller.token) })).json()) as Page;
    const all = await list();
    check("newest first: the message, then the offer", all.items.map((i) => i.title).join(" | ") === "Push Test Buyer | New offer: ₦8,000", all.items.map((i) => i.title).join(" | "));
    check("a switched-off topic isn't listed", all.items.length === 2);
    check("both unread", all.unread === 2 && all.items.every((i) => !i.read));
    check("the offer opens its conversation", !!all.items[1]?.conversationId && all.items[1]?.dealId === deal.id);
    const msgs = await list("?topic=messages");
    check("filter by topic", msgs.items.length === 1 && msgs.items[0]!.topic === "messages");
    const paged = await list("?limit=1");
    const page2 = await list(`?limit=1&before=${paged.nextBefore}`);
    check("pages", paged.items.length === 1 && page2.items[0]?.title === "New offer: ₦8,000" && page2.nextBefore === null);
    await fetch(`${API}/conversations/${msgs.items[0]!.conversationId}/read`, { method: "POST", headers: H(seller.token) });
    const afterRead = await list();
    check("reading the chat reads its message notification", afterRead.unread === 1 && afterRead.items[0]!.read && !afterRead.items[1]!.read, `unread=${afterRead.unread}`);
    const one = await fetch(`${API}/me/notifications/read`, { method: "POST", headers: H(seller.token), body: JSON.stringify({}) });
    const unread = (await (await fetch(`${API}/me/notifications/unread`, { headers: H(seller.token) })).json()) as { unread: number };
    check("mark all read", one.status === 200 && unread.unread === 0);
    const other = await fetch(`${API}/me/notifications`, { headers: H(buyer.token) });
    const otherPage = (await other.json()) as Page;
    check("only your own", !otherPage.items.some((i) => i.title.startsWith("New offer")));
  } finally {
    await sql.end();
  }
  console.log(pass ? "VERDICT → PASS ✅ push notifications decided and relayed (deployed)" : "VERDICT → FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
