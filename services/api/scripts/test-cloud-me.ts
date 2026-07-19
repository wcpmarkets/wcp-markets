import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * End-to-end proof of the deployed API's cloud DB path:
 *   1. create a throwaway cloud user, sign in for a real ES256 token
 *   2. call the DEPLOYED GET /me with it → expect 200
 *   3. confirm a profiles row was actually written in the cloud DB (PostgREST),
 *      which proves /me hit Postgres (via the SSM DATABASE_URL), not the no-DB stub
 *   4. delete the user (cascades the profile row)
 *
 * Reads SUPABASE_URL + a service key from apps/marketing/.env.local so no secret
 * is ever passed on a command line. API base from API_URL env.
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

async function del(id: string, admin: Record<string, string>) {
  const d = await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
  console.log(`6) delete test user      → ${d.status}`);
}

async function main() {
  if (!BASE || !SERVICE) throw new Error("missing SUPABASE_URL / service key in .env.local");
  if (!API) throw new Error("missing API_URL env");

  const email = `clitest+${Date.now()}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const user = (await cr.json()) as { id: string };
  console.log(`1) create cloud user     → ${cr.status} id=${user.id}`);

  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sess = (await si.json()) as { access_token?: string };
  const token = sess.access_token;
  if (!token) {
    console.error("no access_token:", JSON.stringify(sess).slice(0, 200));
    await del(user.id, admin);
    process.exit(1);
  }
  console.log(`2) sign in               → ${si.status}`);

  // Retry /me a few times: a cold Lambda that cached a null DB (param created
  // after its first boot) retries SSM on the next request.
  let meStatus = 0;
  let meBody = "";
  for (let i = 1; i <= 4; i++) {
    const me = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } });
    meStatus = me.status;
    meBody = await me.text();
    console.log(`3) GET /me (deployed) #${i} → ${meStatus} ${meBody}`);
    if (meStatus === 200) break;
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Did the Lambda actually write the profile row in the cloud DB?
  const pr = await fetch(
    `${BASE}/rest/v1/profiles?id=eq.${user.id}&select=id,phone,verification_level`,
    { headers: admin },
  );
  const rows = (await pr.json()) as unknown[];
  const wrote = Array.isArray(rows) && rows.length === 1;
  console.log(`4) profiles row in cloud → ${pr.status} count=${Array.isArray(rows) ? rows.length : "?"} ${JSON.stringify(rows).slice(0, 160)}`);
  console.log(`5) VERDICT               → ${meStatus === 200 && wrote ? "PASS ✅ deployed /me wrote to cloud Postgres via SSM" : "FAIL ❌ still on the no-DB stub (or DB error)"}`);

  await del(user.id, admin);
  process.exit(meStatus === 200 && wrote ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
