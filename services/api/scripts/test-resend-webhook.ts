import { createHmac, randomBytes } from "node:crypto";
import { verifySvix } from "../src/routes/resend-webhook.js";

/**
 * /webhooks/resend signature check (Svix scheme), offline, plus the deployed endpoint's
 * refusal of unsigned calls.   API_URL=… npx tsx scripts/test-resend-webhook.ts
 */
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
const key = randomBytes(24);
const whsec = `whsec_${key.toString("base64")}`;
const body = JSON.stringify({ type: "email.bounced", data: { email_id: "x", to: ["a@b.com"] } });
const now = Math.floor(Date.now() / 1000);
const sign = (id: string, ts: number, raw: string, k = key) => `v1,${createHmac("sha256", k).update(`${id}.${ts}.${raw}`).digest("base64")}`;

check("valid signature accepted", verifySvix(body, "msg_1", String(now), sign("msg_1", now, body), whsec));
check("one of several signatures (rotation) accepted", verifySvix(body, "msg_1", String(now), `v1,AAAA ${sign("msg_1", now, body)}`, whsec));
check("tampered body rejected", !verifySvix(body + " ", "msg_1", String(now), sign("msg_1", now, body), whsec));
check("wrong secret rejected", !verifySvix(body, "msg_1", String(now), sign("msg_1", now, body, randomBytes(24)), whsec));
check("old timestamp (10 min) rejected", !verifySvix(body, "msg_1", String(now - 600), sign("msg_1", now - 600, body), whsec));
check("missing id rejected", !verifySvix(body, "", String(now), sign("", now, body), whsec));

if (process.env.API_URL) {
  const r = await fetch(`${process.env.API_URL.replace(/\/$/, "")}/webhooks/resend`, { method: "POST", body, headers: { "Content-Type": "application/json" } });
  check("deployed: unsigned call refused (401, or 503 until the secret is in SSM)", r.status === 401 || r.status === 503, String(r.status));
}
console.log(`\nVERDICT → ${pass ? "PASS ✅ resend webhook" : "FAIL ❌"}`);
process.exit(pass ? 0 : 1);
