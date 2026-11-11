/**
 * Dev helper: a phone-only buyer + a ps- seller + an ACCEPTED Paystack deal (₦5,000),
 * for device-testing checkout. Writes the buyer session (tokens) to the JSON path given
 * as the first argument — keep that file out of the repo.
 *
 *   API_URL=… npx tsx scripts/dev-device-deal.ts <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const env: Record<string, string> = {};
for (const l of readFileSync(resolve(process.cwd(), "../../apps/marketing/.env.local"), "utf8").split(/\r?\n/)) { const m = /^([A-Z_]+)=(.*)$/.exec(l); if (m) env[m[1]!] = m[2]!.trim().replace(/^["']|["']$/g, ""); }
const BASE = env.SUPABASE_URL!, SERVICE = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY!;
const API = process.env.API_URL!, OUT = process.argv[2]!;
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
const H = (t: string) => ({ Authorization: `Bearer ${t}`, "Content-Type": "application/json" });
const pw = () => `Dev-${Math.random().toString(36).slice(2)}9!`;
async function signIn(body: object) {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as any; if (!r.ok) throw new Error(`sign-in ${r.status} ${JSON.stringify(j).slice(0, 200)}`); return j;
}
// Buyer: phone-only, like a real WCP buyer (no email → the receipt field shows).
const phone = `2347000${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`, bp = pw();
let r = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ phone, password: bp, phone_confirm: true }) });
const buyerId = ((await r.json()) as any).id; if (!r.ok) throw new Error(`buyer ${r.status}`);
const bs = await signIn({ phone, password: bp });
// Seller: a ps- test account (email; the rail follows the buyer).
const se = `clitest+ps-dev${Date.now()}@wcp-test.local`, sp = pw();
r = await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email: se, password: sp, email_confirm: true }) });
const sellerId = ((await r.json()) as any).id;
const ss = await signIn({ email: se, password: sp });
await fetch(`${API}/me`, { method: "PATCH", headers: H(ss.access_token), body: JSON.stringify({ displayName: "Device Test Seller" }) });
const lr = await fetch(`${API}/listings`, { method: "POST", headers: H(ss.access_token), body: JSON.stringify({ category: "phones", title: "Device test — Nokia 105", priceKobo: 500_000, stock: 1 }) });
const listing = (await lr.json()) as any;
const or = await fetch(`${API}/listings/${listing.id}/offers`, { method: "POST", headers: H(bs.access_token), body: JSON.stringify({ priceKobo: 500_000 }) });
const deal = (await or.json()) as any;
const ar = await fetch(`${API}/deals/${deal.id}/actions`, { method: "POST", headers: H(ss.access_token), body: JSON.stringify({ action: "accept" }) });
const d = (await (await fetch(`${API}/deals/${deal.id}`, { headers: H(bs.access_token) })).json()) as any;
writeFileSync(OUT, JSON.stringify({ buyerId, phone, buyer: { access: bs.access_token, refresh: bs.refresh_token, expiresAt: bs.expires_at }, sellerId, sellerEmail: se, sellerPw: sp, listingId: listing.id, dealId: deal.id }));
console.log(`buyer ${buyerId} (+${phone.slice(0, 7)}…)  seller ${sellerId}  listing ${lr.status}  offer ${or.status}  accept ${ar.status}`);
console.log(`deal ${deal.id} state=${d.state} rail=${d.payment?.rail} total=${d.payment?.totalKobo}`);
