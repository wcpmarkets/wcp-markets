import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Publish-time screening live (0041, design 13d-flagged) on the DEPLOYED API: a clean
 * listing goes live, contact details / pay-outside-escrow / a far-too-low price hold
 * it, a held listing is hidden from the public but visible (with reasons) to its
 * owner, the seller can't un-hold it by status, fixing the text clears the hold, and
 * staff approve / reject from the queue — with the seller notified.
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-screening.ts
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

type Flag = { code: string; detail: string };
type L = { id: string; status: string; review?: { flags: Flag[]; decision: string | null; note: string | null } | null };

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("sc-s");
  const other = await newUser("sc-o");
  const staff = await newUser("sc-staff");
  const users = [seller, other, staff];
  const cat = `sctest${Date.now()}`;
  const post = async (u: U, body: Record<string, unknown>) =>
    api("/listings", u.token, {
      method: "POST",
      body: JSON.stringify({ attributes: { delivery: { modes: ["meet"] } }, category: cat, condition: "used", priceKobo: 10_000_000, stock: 1, state: "Lagos", city: "Yaba", ...body }),
    });
  const mine = async (id: string) => {
    const r = await j<L[] | { items: L[] }>(await api("/listings/mine", seller.token));
    return (Array.isArray(r) ? r : r.items).find((l) => l.id === id);
  };
  const isPublic = async (id: string) => (await api(`/listings/${id}`, null)).status === 200;
  try {
    await sql`insert into public.staff_roles (user_id, role) values (${staff.id}, 'admin') on conflict (user_id) do update set role = 'admin'`;

    console.log("clean listing");
    const clean = await j<L>(await post(seller, { title: "sc clean phone", description: "Lightly used, box and charger included." }));
    check("clean → active, no review", clean.status === "active" && !clean.review, clean.status);
    check("clean is public", await isPublic(clean.id));

    console.log("contact details");
    const phoneR = await post(seller, { title: "sc phone", description: "Call me on 0803 123 4567 for quick deal" });
    const phone = await j<L>(phoneR);
    check("phone number → 201 held", phoneR.status === 201 && phone.status === "held", `${phoneR.status} ${phone.status}`);
    check("owner sees the reason", phone.review?.flags.some((f) => f.code === "contact_details") === true);
    check("held is hidden from the public", !(await isPublic(phone.id)));
    check("held appears in /listings/mine with review", (await mine(phone.id))?.review?.flags.length === 1);
    const unhold = await api(`/listings/${phone.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
    check("seller can't un-hold by status → 409", unhold.status === 409, `${unhold.status}`);
    const fixed = await j<L>(await api(`/listings/${phone.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ description: "Clean unit, chat here to arrange." }) }));
    check("fixing the text clears the hold → active", fixed.status === "active" && !fixed.review, fixed.status);
    check("now public", await isPublic(phone.id));
    const relapse = await j<L>(await api(`/listings/${phone.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ description: "WhatsApp me" }) }));
    check("editing contact details back in → held again", relapse.status === "held", relapse.status);

    console.log("pay outside escrow");
    const pay = await j<L>(await post(seller, { title: "sc laptop", description: "Pay into my account first then I send it" }));
    check("off-platform payment → held", pay.status === "held" && pay.review?.flags.some((f) => f.code === "off_platform_payment") === true);

    console.log("price far below");
    for (let i = 0; i < 5; i++) await post(other, { title: `sc comp ${i}`, priceKobo: 10_000_000 + i * 100_000 });
    const cheap = await j<L>(await post(seller, { title: "sc bargain", priceKobo: 2_000_000 }));
    check("20% of the median → held, price_far_below", cheap.status === "held" && cheap.review?.flags[0]?.code === "price_far_below", cheap.status);
    const fair = await j<L>(await post(seller, { title: "sc fair", priceKobo: 6_000_000 }));
    check("60% of the median → active", fair.status === "active", fair.status);

    console.log("staff queue");
    const q403 = await api("/admin/listings/held", seller.token);
    check("non-staff → 403", q403.status === 403, `${q403.status}`);
    const q = await j<{ id: string; flags: Flag[] }[]>(await api("/admin/listings/held?limit=100", staff.token));
    check("queue has the three held listings", [relapse.id, pay.id, cheap.id].every((id) => q.some((x) => x.id === id)), `${q.length}`);
    const noNote = await api(`/admin/listings/${pay.id}/review`, staff.token, { method: "POST", body: JSON.stringify({ decision: "reject" }) });
    check("reject without a note → 400", noNote.status === 400, `${noNote.status}`);
    const rej = await api(`/admin/listings/${pay.id}/review`, staff.token, { method: "POST", body: JSON.stringify({ decision: "reject", note: "Payments go through escrow only — please relist without that line." }) });
    check("reject → removed", rej.status === 200 && (await j<{ status: string }>(rej)).status === "removed");
    const rejMine = await mine(pay.id);
    check("seller sees the rejection note", rejMine?.status === "removed" && rejMine.review?.decision === "rejected" && !!rejMine.review?.note);
    const apr = await api(`/admin/listings/${cheap.id}/review`, staff.token, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    check("approve → active and public", apr.status === 200 && (await isPublic(cheap.id)));
    const again = await api(`/admin/listings/${cheap.id}/review`, staff.token, { method: "POST", body: JSON.stringify({ decision: "approve" }) });
    check("reviewing twice → 404", again.status === 404, `${again.status}`);
    const reprice = await j<L>(await api(`/listings/${cheap.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ priceKobo: 1_900_000 }) }));
    check("approved price flag doesn't re-hold on a small edit", reprice.status === "active", reprice.status);
    const notes = await sql<{ title: string }[]>`select title from public.notifications where user_id = ${seller.id} order by created_at`;
    check("seller notified of both decisions", notes.length >= 2, notes.map((n) => n.title).join(" | "));
  } finally {
    await sql`delete from public.staff_roles where user_id = ${staff.id}`;
    await sql`delete from public.notifications where user_id = any(${users.map((u) => u.id)})`;
    await sql`delete from public.listings where seller_id = any(${users.map((u) => u.id)})`;
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ publish-time screening + staff review work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
