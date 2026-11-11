import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Smile ID KYC on the DEPLOYED API (0035), up to what can run without a camera.
 *
 *   A. POST /kyc/session → provider "smileid" with a token: Smile ID's sandbox accepted
 *      our partner ID + key and the bound payload (ID, names, consent).
 *   B. The attempt row keeps the keyed hash only — never the number.
 *   C. The mock /kyc/verify is closed now (409 use_smileid) — no bypass.
 *   D. A submitted job ID that Smile ID doesn't know stays 'processing' and the user
 *      stays L1; a second, different job for the same attempt → 409.
 *   E. The webhook rejects an unsigned call (401).
 *
 * The capture itself (selfie → Smile ID → clear) is the device test.
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

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const email = `clitest+smileid${Date.now()}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const { id: uid } = (await (await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  try {
    const token = ((await (await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).json()) as { access_token: string }).access_token;
    const idNumber = "00000000000";

    console.log("A. session");
    const r = await fetch(`${API}/kyc/session`, { method: "POST", headers: H(token), body: JSON.stringify({ idType: "bvn", idNumber, givenNames: "Test", lastName: "User" }) });
    const s = (await r.json()) as { provider?: string; token?: string | null; partnerId?: string | null; sandbox?: boolean; attemptId?: string | null; smileIdType?: string | null; error?: string };
    check("200", r.status === 200, `${r.status} ${s.error ?? ""}`);
    check("provider smileid", s.provider === "smileid", s.provider);
    check("a token from Smile ID", typeof s.token === "string" && s.token.split(".").length === 3);
    check("sandbox, BVN", s.sandbox === true && s.smileIdType === "BVN");
    const raw = JSON.stringify(s);
    check("the response doesn't echo the number", !raw.includes(idNumber));

    console.log("B. attempt row");
    const [a] = await sql<{ id_hash: string | null; status: string; provider: string }[]>`select id_hash, status, provider from public.kyc_attempts where id = ${s.attemptId ?? "00000000-0000-0000-0000-000000000000"}`;
    check("started, smileid", a?.status === "started" && a.provider === "smileid", JSON.stringify(a));
    check("keyed hash kept, not the number", !!a?.id_hash && a.id_hash !== idNumber && !a.id_hash.includes(idNumber));

    console.log("C. mock closed");
    const mv = await fetch(`${API}/kyc/verify`, { method: "POST", headers: H(token), body: JSON.stringify({ idType: "bvn", idNumber }) });
    check("409 use_smileid", mv.status === 409 && ((await mv.json()) as { error: string }).error === "use_smileid");

    console.log("D. submit");
    const fake = `job_${"0".repeat(26)}`;
    const sub = await fetch(`${API}/kyc/attempts/${s.attemptId}/submitted`, { method: "POST", headers: H(token), body: JSON.stringify({ jobId: fake }) });
    const st = (await sub.json()) as { level: number; pending: boolean };
    check("unknown job → pending, still L1", sub.status === 200 && st.pending && st.level === 1, JSON.stringify(st));
    const again = await fetch(`${API}/kyc/attempts/${s.attemptId}/submitted`, { method: "POST", headers: H(token), body: JSON.stringify({ jobId: `job_${"1".repeat(26)}` }) });
    check("a different job → 409", again.status === 409);

    console.log("E. webhook");
    const wh = await fetch(`${API}/webhooks/smileid`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ job_id: fake, status: "clear" }) });
    check("unsigned → 401", wh.status === 401, `${wh.status}`);
    const [after] = await sql<{ level: number }[]>`select coalesce((select verification_level from public.profiles where id = ${uid}), 1) as level`;
    check("still L1", after?.level === 1);
  } finally {
    await sql.end();
    await fetch(`${BASE}/auth/v1/admin/users/${uid}`, { method: "DELETE", headers: admin });
  }
  console.log(pass ? "VERDICT → PASS ✅ Smile ID sessions (deployed, sandbox)" : "VERDICT → FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
