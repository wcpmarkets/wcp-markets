import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Phase 3 B live — reporting and moderation on the DEPLOYED API: filing reports,
 * the bounded auto-pause, what a paused listing looks like to the public and to its
 * seller, the DB guard on moderation statuses, and the staff queue + decisions.
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-reports.ts
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
const report = (t: string, body: Record<string, unknown>) => api("/reports", t, { method: "POST", body: JSON.stringify(body) });
type Receipt = { id: string; duplicate: boolean; listingPaused: boolean; blocked: boolean };

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const seller = await newUser("rp-s");
  const buyer = await newUser("rp-b");
  const r2 = await newUser("rp-2");
  const r3 = await newUser("rp-3");
  const staff = await newUser("rp-staff");
  const users = [seller, buyer, r2, r3, staff];
  const newListing = async (title: string) =>
    j<{ id: string }>(await api("/listings", seller.token, { method: "POST", body: JSON.stringify({ category: "phones", title, priceKobo: 5_000_000, stock: 1, state: "Lagos", city: "Yaba" }) }));
  const publicStatus = async (id: string) => (await api(`/listings/${id}`, null)).status;
  try {
    await sql`insert into public.staff_roles (user_id, role) values (${staff.id}, 'admin') on conflict (user_id) do update set role = 'admin'`;

    // ── Filing ────────────────────────────────────────────────────────────
    console.log("filing");
    const A = await newListing("rp listing A");
    const first = await report(r2.token, { targetType: "listing", listingId: A.id, reason: "misleading", details: "Photos are of a different model" });
    const firstR = await j<Receipt>(first);
    check("report a listing → 201", first.status === 201 && !firstR.duplicate, `${first.status}`);
    check("one misleading report doesn't pause it", !firstR.listingPaused && (await publicStatus(A.id)) === 200);
    const again = await report(r2.token, { targetType: "listing", listingId: A.id, reason: "scam" });
    const againR = await j<Receipt>(again);
    check("same reporter again → 200 duplicate, same id", again.status === 200 && againR.duplicate && againR.id === firstR.id);
    check("can't report your own listing", (await report(seller.token, { targetType: "listing", listingId: A.id, reason: "other" })).status === 400);
    check("missing listingId → 400", (await report(r2.token, { targetType: "listing", reason: "other" })).status === 400);
    check("unknown listing → 404", (await report(r2.token, { targetType: "listing", listingId: "00000000-0000-4000-8000-000000000000", reason: "other" })).status === 404);
    const anon = await fetch(`${API}/reports`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetType: "listing", listingId: A.id, reason: "other" }) });
    check("signed out → 401", anon.status === 401, `${anon.status}`);

    // ── Threshold auto-pause: 3 distinct reporters ────────────────────────
    console.log("threshold pause");
    await report(r3.token, { targetType: "listing", listingId: A.id, reason: "misleading" });
    check("two reporters: still live", (await publicStatus(A.id)) === 200);
    const third = await j<Receipt>(await report(buyer.token, { targetType: "listing", listingId: A.id, reason: "counterfeit" }));
    check("third distinct reporter pauses it", third.listingPaused === true);
    check("paused listing is gone from public detail", (await publicStatus(A.id)) === 404);
    const browse = await j<{ items: { id: string }[] }>(await api("/listings?limit=50&state=Lagos&city=Yaba", null));
    check("…and from browse", !browse.items.some((i) => i.id === A.id));
    const mine = await j<{ items: { id: string; status: string }[] } | { id: string; status: string }[]>(await api("/listings/mine", seller.token));
    const mineItems = Array.isArray(mine) ? mine : mine.items;
    check("seller still sees it as under_review", mineItems.find((i) => i.id === A.id)?.status === "under_review");
    const reactivate = await api(`/listings/${A.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
    check("seller can't reactivate it → 409", reactivate.status === 409 && (await j<{ error: string }>(reactivate)).error === "listing_under_moderation", `${reactivate.status}`);
    const edit = await api(`/listings/${A.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ title: "rp listing A (fixed photos)" }) });
    check("seller can still edit its details", edit.status === 200, `${edit.status}`);
    check("no new chats on a paused listing", (await api(`/listings/${A.id}/conversations`, r2.token, { method: "POST" })).status !== 201);
    let guard = "";
    try { await sql`update public.listings set status = 'active' where id = ${A.id}`; } catch (e) { guard = (e as Error).message; }
    check("DB guard blocks a direct status change", guard.includes("under moderation"), guard.slice(0, 60));

    // ── Engaged scam report pauses at once ────────────────────────────────
    console.log("engaged scam pause");
    const B = await newListing("rp listing B");
    const strangerScam = await j<Receipt>(await report(r2.token, { targetType: "listing", listingId: B.id, reason: "scam" }));
    check("scam report from someone who never chatted: no pause", !strangerScam.listingPaused && (await publicStatus(B.id)) === 200);
    const conv = await j<{ id: string }>(await api(`/listings/${B.id}/conversations`, buyer.token, { method: "POST" }));
    const msg = await j<{ id: number }>(await api(`/conversations/${conv.id}/messages`, seller.token, { method: "POST", body: JSON.stringify({ body: "Pay me by bank transfer, skip escrow" }) }));
    const engaged = await j<Receipt>(await report(buyer.token, { targetType: "listing", listingId: B.id, reason: "scam", block: true }));
    check("scam report from a buyer in the thread pauses immediately", engaged.listingPaused && (await publicStatus(B.id)) === 404);
    check("…and 'also block' blocked the seller", engaged.blocked && (await j<{ blockedByMe: boolean }>(await api(`/users/${seller.id}`, buyer.token))).blockedByMe);

    // ── Message + user reports ────────────────────────────────────────────
    console.log("message + user reports");
    const mr = await report(buyer.token, { targetType: "message", messageId: msg.id, reason: "scam", details: "asked to pay off-platform" });
    check("party reports a message → 201", mr.status === 201, `${mr.status} ${mr.status === 201 ? "" : await mr.text()} msg=${JSON.stringify(msg)}`);
    check("stranger can't report that message → 403", (await report(r3.token, { targetType: "message", messageId: msg.id, reason: "scam" })).status === 403);
    check("report a person → 201", (await report(r3.token, { targetType: "user", userId: seller.id, reason: "harassment" })).status === 201);
    check("can't report yourself", (await report(r3.token, { targetType: "user", userId: r3.id, reason: "other" })).status === 400);

    // ── Staff queue ───────────────────────────────────────────────────────
    console.log("staff");
    check("non-staff queue → 403", (await api("/admin/reports", r2.token)).status === 403);
    const queue = await j<{ id: string; targetType: string; listing: { id: string } | null; openReportsOnTarget: number; reportsAgainstUser30d: number; pausedListing: boolean; message: { body: string } | null }[]>(await api("/admin/reports?limit=100", staff.token));
    const qa = queue.filter((q) => q.listing?.id === A.id);
    check("queue shows all three reports on A", qa.length === 3 && qa.every((q) => q.openReportsOnTarget === 3), `${qa.length}`);
    check("queue counts reports against the seller", (qa[0]?.reportsAgainstUser30d ?? 0) >= 7, `${qa[0]?.reportsAgainstUser30d}`);
    check("queue carries the reported message body", queue.some((q) => q.message?.body.includes("bank transfer")));
    check("non-staff resolve → 403", (await api(`/admin/reports/${qa[0]!.id}/resolve`, r2.token, { method: "POST", body: JSON.stringify({ action: "dismiss" }) })).status === 403);

    // Dismiss A: back on sale, all three closed.
    const dis = await api(`/admin/reports/${qa[0]!.id}/resolve`, staff.token, { method: "POST", body: JSON.stringify({ action: "dismiss", note: "photos fixed" }) });
    const disR = await j<{ resolved: number; listingStatus: string | null }>(dis);
    check("dismiss closes all 3 and restores the listing", dis.status === 200 && disR.resolved === 3 && disR.listingStatus === "active", JSON.stringify(disR));
    check("A is public again", (await publicStatus(A.id)) === 200);
    check("resolved report can't be resolved twice → 404", (await api(`/admin/reports/${qa[0]!.id}/resolve`, staff.token, { method: "POST", body: JSON.stringify({ action: "dismiss" }) })).status === 404);
    check("after a decision the same person may report again", (await report(r2.token, { targetType: "listing", listingId: A.id, reason: "other" })).status === 201);

    // Remove B via the message report: listing removed, its listing reports closed too.
    const q2 = await j<{ id: string; targetType: string; message: unknown }[]>(await api("/admin/reports?targetType=message", staff.token));
    const msgReport = q2.find((q) => q.message !== null)!;
    const rm = await j<{ resolved: number; listingStatus: string | null }>(await api(`/admin/reports/${msgReport.id}/resolve`, staff.token, { method: "POST", body: JSON.stringify({ action: "remove_listing", note: "off-platform payment" }) }));
    check("remove_listing from a message report removes B", rm.listingStatus === "removed", JSON.stringify(rm));
    const [openOnB] = await sql<{ n: number }[]>`select count(*)::int as n from public.reports where listing_id = ${B.id} and status = 'open'`;
    check("…and closes B's listing reports", openOnB?.n === 0, `${openOnB?.n}`);
    check("seller can't relist a removed listing → 409", (await api(`/listings/${B.id}`, seller.token, { method: "PATCH", body: JSON.stringify({ status: "active" }) })).status === 409);

    // Conflict of interest: staff can't rule on a report that names them.
    await report(r2.token, { targetType: "user", userId: staff.id, reason: "other" });
    const q3 = await j<{ id: string; reportedUser: { id: string } }[]>(await api("/admin/reports?targetType=user", staff.token));
    const aboutStaff = q3.find((q) => q.reportedUser.id === staff.id)!;
    const coi = await api(`/admin/reports/${aboutStaff.id}/resolve`, staff.token, { method: "POST", body: JSON.stringify({ action: "dismiss" }) });
    check("staff can't resolve a report about themselves → 403", coi.status === 403 && (await j<{ error: string }>(coi)).error === "conflict_of_interest");
    const userReport = q3.find((q) => q.reportedUser.id === seller.id)!;
    const up = await j<{ resolved: number }>(await api(`/admin/reports/${userReport.id}/resolve`, staff.token, { method: "POST", body: JSON.stringify({ action: "uphold", note: "warned" }) }));
    check("uphold a person report", up.resolved === 1);
  } finally {
    await sql`delete from public.staff_roles where user_id = ${staff.id}`;
    await sql`delete from public.listings where seller_id = ${seller.id}`;
    await sql.end({ timeout: 5 });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ reporting + moderation work end-to-end (deployed)" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
