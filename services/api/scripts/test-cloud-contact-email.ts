import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Receipt email (PUT /me/email, GET /email/verify) on the DEPLOYED API.
 *
 *   A. /me shows no confirmed email for a test account (.local doesn't count).
 *   B. bad shape / reserved ending → 400; a real address → saved, shown as pendingEmail.
 *   C. another account's confirmed email → 409.
 *   D. the link: a bad token → 400 page; a known token (planted, since the real one is
 *      only in the email) → page "confirmed", and the address becomes the account's
 *      confirmed email; the token is single-use.
 *
 * Addresses are plus-addresses on our own mailbox (cx+…@wcpmarkets.com). Test accounts
 * are deleted at the end.
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
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const made: string[] = [];
async function newUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: { ...admin, "Content-Type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  const { id } = (await cr.json()) as { id: string };
  made.push(id);
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const tag = `${Date.now()}`;
  const addr = `cx+verifytest${tag}@wcpmarkets.com`;
  try {
    const a = await newUser("em-");
    const b = await newUser("em-");

    console.log("A. /me");
    const me0 = (await (await fetch(`${API}/me`, { headers: H(a.token) })).json()) as { email: string | null; pendingEmail: string | null };
    check("no confirmed email (reserved .local doesn't count)", me0.email === null, JSON.stringify(me0.email));
    check("no pending email", me0.pendingEmail === null);

    console.log("B. save");
    const put = (t: string, email: string) => fetch(`${API}/me/email`, { method: "PUT", headers: H(t), body: JSON.stringify({ email }) });
    check("bad shape → 400", (await put(a.token, "not-an-email")).status === 400);
    check("reserved ending → 400", (await put(a.token, "x@foo.local")).status === 400);
    const ok = await put(a.token, addr.toUpperCase());
    const okBody = (await ok.json()) as { email: string; verified: boolean; verificationSent: boolean };
    check("real address → 200, unverified, lowercased", ok.status === 200 && !okBody.verified && okBody.email === addr, JSON.stringify(okBody));
    console.log(`   • confirmation email sent: ${okBody.verificationSent} (false until the Resend key is in SSM)`);
    const me1 = (await (await fetch(`${API}/me`, { headers: H(a.token) })).json()) as { email: string | null; pendingEmail: string | null };
    check("/me shows it as pending", me1.pendingEmail === addr && me1.email === null);

    console.log("D. the link");
    const bad = await fetch(`${API}/email/verify?t=nope`);
    check("bad token → 400 page", bad.status === 400 && (bad.headers.get("content-type") ?? "").includes("text/html"));
    const token = randomBytes(32).toString("base64url");
    await sql`update public.contact_emails set token_hash = ${createHash("sha256").update(token).digest("hex")} where user_id = ${a.id}`;
    const v = await fetch(`${API}/email/verify?t=${token}`);
    const vText = await v.text();
    check("known token → confirmed page", v.status === 200 && vText.includes("Email confirmed"), `${v.status}`);
    const me2 = (await (await fetch(`${API}/me`, { headers: H(a.token) })).json()) as { email: string | null; pendingEmail: string | null };
    check("now the account's confirmed email", me2.email === addr && me2.pendingEmail === null, JSON.stringify(me2));
    const again = await fetch(`${API}/email/verify?t=${token}`);
    check("link is single-use", again.status === 400);

    console.log("C. taken");
    const taken = await put(b.token, addr);
    check("another account's confirmed email → 409", taken.status === 409, `${taken.status}`);
  } finally {
    for (const id of made) await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
    await sql.end();
  }
  console.log(pass ? "VERDICT → PASS ✅ receipt email works end-to-end (deployed)" : "VERDICT → FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
