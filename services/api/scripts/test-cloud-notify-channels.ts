import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Email + SMS notification channels (0044), run in-process against the live database
 * with both providers forced to mock — nothing is emailed or texted:
 *
 *   defaults (email off): push only · email on → email · urgent → SMS, non-urgent → none
 *   SMS off → none · topic off → nothing anywhere · push off → push skipped, email still
 *   a chat emails once an hour per conversation · no confirmed email / no phone → no_address
 *   every SMS lands in sms_log tied to its notification, as one 160-char segment
 *
 *   npx tsx scripts/test-cloud-notify-channels.ts
 */
// Empty keys: the senders see "no key" and mock. Set before the modules load.
process.env.RESEND_API_KEY = "";
process.env.TERMII_API_KEY = "";
process.env.FCM_SERVICE_ACCOUNT = "";
const { deliver, smsText } = await import("../src/notify/push.js");

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
const db = postgres((await fetchSsm("/wcp/api/database-url"))!, { prepare: false, max: 2 });

let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };

const stamp = Date.now();
// A reserved test range (234700…) — and SMS is mocked regardless.
const phone = `2347000${String(stamp).slice(-6)}`;
async function newUser(opts: { email: string; phone?: string }): Promise<string> {
  const r = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST", headers: admin,
    body: JSON.stringify({ email: opts.email, email_confirm: true, password: `T-${randomUUID()}9!`, ...(opts.phone ? { phone: opts.phone, phone_confirm: true } : {}) }),
  });
  const j = (await r.json()) as { id?: string; msg?: string };
  if (!j.id) throw new Error(`create user: ${r.status} ${JSON.stringify(j)}`);
  await db`insert into public.profiles (id) values (${j.id}) on conflict (id) do nothing`;
  return j.id;
}
const setPrefs = (uid: string, channels: Record<string, boolean>, topics: Record<string, boolean> = {}) =>
  db`update public.profiles set notification_prefs = ${db.json({
    channels: { push: true, whatsapp: false, email: false, sms: true, ...channels },
    topics: { watch: true, orders: true, messages: true, promotions: false, ...topics },
  })} where id = ${uid}`;

type Row = { status: string; email_status: string | null; sms_status: string | null; detail: string | null; id: number };
let n = 0;
async function send(uid: string, o: { topic?: "orders" | "messages" | "watch"; urgent?: boolean; conv?: string; body?: string } = {}): Promise<Row> {
  const key = o.topic === "messages" ? `msg:${-stamp * 100 - ++n}` : `nc:${stamp}:${++n}`;
  await deliver(db, {
    userId: uid, topic: o.topic ?? "orders", title: o.topic === "messages" ? "Ada" : "Paid — hand it over",
    body: o.body ?? "Ada paid ₦8,000 into escrow for iPhone 13. Hand it off, then mark it handed off.",
    key, data: o.conv ? { type: "conversation", conversationId: o.conv } : { type: "deal", dealId: randomUUID() }, urgent: o.urgent,
  });
  const [r] = await db<Row[]>`select id, status, email_status, sms_status, detail from public.notifications where dedupe_key = ${key}`;
  return r!;
}

const users: string[] = [];
try {
  const u = await newUser({ email: `nc-${stamp}@wcp-notify-test.com`, phone });
  const bare = await newUser({ email: `clitest+nc-${stamp}@wcp-test.local` }); // undeliverable, no phone
  users.push(u, bare);

  console.log("defaults (email off, SMS on)");
  let r = await send(u);
  check("push decided (no device)", r.status === "no_device", r.status);
  check("email not attempted", r.email_status === null, String(r.email_status));
  check("non-urgent → no SMS", r.sms_status === null, String(r.sms_status));
  r = await send(u, { urgent: true });
  check("urgent → SMS", r.sms_status === "mocked", String(r.sms_status));
  const [log] = await db<{ kind: string; body: string; to_phone: string }[]>`select kind, body, to_phone from public.sms_log where notification_id = ${r.id}`;
  check("…logged in sms_log for that notification", log?.kind === "notification" && log.to_phone === phone);
  check("…one segment, branded", !!log && log.body.length <= 160 && log.body.startsWith("WCP Markets: "), `${log?.body.length} chars`);
  check("long text clipped to 160", smsText({ body: "x".repeat(400) }).length === 160);

  console.log("email on");
  await setPrefs(u, { email: true });
  r = await send(u);
  check("order → email", r.email_status === "mocked", String(r.email_status));
  const c1 = randomUUID(), c2 = randomUUID();
  const m1 = await send(u, { topic: "messages", conv: c1, body: "Is it still available?" });
  const m2 = await send(u, { topic: "messages", conv: c1, body: "Hello?" });
  const m3 = await send(u, { topic: "messages", conv: c2, body: "Hi" });
  check("first message in a chat → email", m1.email_status === "mocked", String(m1.email_status));
  check("next one within the hour → throttled", m2.email_status === "throttled", String(m2.email_status));
  check("a different chat → email", m3.email_status === "mocked", String(m3.email_status));
  check("messages are never SMS", m1.sms_status === null && m3.sms_status === null);

  console.log("switches");
  await setPrefs(u, { email: true, sms: false });
  r = await send(u, { urgent: true });
  check("SMS off → no SMS even when urgent", r.sms_status === null, String(r.sms_status));
  await setPrefs(u, { email: true, push: false });
  r = await send(u, { urgent: true });
  check("push off → push skipped…", r.status === "skipped" && r.detail?.startsWith("push_off") === true, `${r.status} ${r.detail}`);
  check("…email and SMS still go", r.email_status === "mocked" && r.sms_status === "mocked", `${r.email_status} ${r.sms_status}`);
  await setPrefs(u, { email: true }, { orders: false });
  r = await send(u, { urgent: true });
  check("topic off → nothing on any channel", r.status === "skipped" && r.detail === "topic_off" && r.email_status === null && r.sms_status === null);

  console.log("no address");
  await setPrefs(bare, { email: true });
  r = await send(bare, { urgent: true });
  check("no deliverable email → no_address", r.email_status === "no_address", String(r.email_status));
  check("no phone → no_address", r.sms_status === "no_address", String(r.sms_status));
  check("push still decided", r.status === "no_device", r.status);
} finally {
  await db`delete from public.sms_log where to_phone = ${phone}`;
  for (const id of users) await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
  await db.end();
}
console.log(`\nVERDICT → ${pass ? "PASS ✅ notification channels" : "FAIL ❌"}`);
process.exit(pass ? 0 : 1);
