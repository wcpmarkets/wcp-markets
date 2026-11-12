import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Account deletion on the DEPLOYED API (0038).
 *
 *   A. an open deal blocks it: /me/deletion lists the deal, DELETE /me → 409, nothing touched;
 *      once the deal is withdrawn it goes through.
 *   B. after deletion: profile "Deleted user" with personal fields cleared; unsold listing
 *      removed; saved / watches / push devices / notifications gone; sessions revoked —
 *      the old token stops working; auth user soft-deleted (phone/email scrubbed) and
 *      can't sign in; the terminal deal is kept for the other side.
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
const users: string[] = [];

async function newUser(tag: string, name: string) {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const { id } = (await (await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  users.push(id);
  const signIn = () => fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  const token = ((await (await signIn()).json()) as { access_token: string }).access_token;
  await fetch(`${API}/me`, { method: "PATCH", headers: H(token), body: JSON.stringify({ displayName: name, bio: "Test bio" }) });
  return { id, token, signIn };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const listing = async (t: string, title: string) =>
    ((await (await fetch(`${API}/listings`, { method: "POST", headers: H(t), body: JSON.stringify({ category: "phones", title, priceKobo: 5_000_000, stock: 1 }) })).json()) as { id: string }).id;

  try {
    const leaver = await newUser("del-a-", "Leaving Seller");
    const buyer = await newUser("del-b-", "Staying Buyer");
    const other = await newUser("del-c-", "Other Seller");

    // Things the leaver owns.
    const mine = await listing(leaver.token, "Deletion test phone");
    const theirs = await listing(other.token, "Deletion test saved item");
    await fetch(`${API}/me/saved/${theirs}`, { method: "PUT", headers: H(leaver.token) });
    await fetch(`${API}/me/watches`, { method: "POST", headers: H(leaver.token), body: JSON.stringify({ label: "x", keywords: "zzdeltest", filters: {} }) });
    await fetch(`${API}/me/push-devices`, { method: "POST", headers: H(leaver.token), body: JSON.stringify({ token: "test-token-" + "x".repeat(40), platform: "android" }) });

    console.log("A. an open deal blocks deletion");
    const o = await fetch(`${API}/listings/${mine}/offers`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ priceKobo: 4_500_000 }) });
    const deal = ((await o.json()) as { id: string }).id;
    check("offer opened", o.status === 201, `${o.status}`);
    const chk = (await (await fetch(`${API}/me/deletion`, { headers: H(leaver.token) })).json()) as { canDelete: boolean; blockers: { kind: string; id: string; label: string }[] };
    check("check: can't, names the deal", !chk.canDelete && chk.blockers.some((b) => b.kind === "deal" && b.id === deal && b.label === "Deletion test phone"), JSON.stringify(chk));
    const blocked = await fetch(`${API}/me`, { method: "DELETE", headers: H(leaver.token) });
    check("DELETE /me → 409", blocked.status === 409, `${blocked.status}`);
    const [still] = await sql<{ display_name: string; deleted_at: Date | null }[]>`select display_name, deleted_at from public.profiles where id = ${leaver.id}`;
    check("…and nothing was touched", still?.display_name === "Leaving Seller" && still.deleted_at === null);

    const wd = await fetch(`${API}/deals/${deal}/actions`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ action: "withdraw" }) });
    check("buyer withdraws", wd.status === 200, `${wd.status}`);
    const chk2 = (await (await fetch(`${API}/me/deletion`, { headers: H(leaver.token) })).json()) as { canDelete: boolean };
    check("check: now it can", chk2.canDelete === true);

    console.log("B. deletion");
    const del = await fetch(`${API}/me`, { method: "DELETE", headers: H(leaver.token) });
    check("DELETE /me → 204", del.status === 204, `${del.status} ${del.status !== 204 ? await del.text() : ""}`);

    const [p] = await sql<{ display_name: string; phone: string | null; bio: string | null; deleted_at: Date | null }[]>`
      select display_name, phone, bio, deleted_at from public.profiles where id = ${leaver.id}`;
    check("profile → Deleted user, cleared", p?.display_name === "Deleted user" && p.bio === null && p.phone === null && p.deleted_at !== null, JSON.stringify(p));
    const [l] = await sql<{ status: string; image_paths: string[] }[]>`select status, image_paths from public.listings where id = ${mine}`;
    check("unsold listing taken down", l?.status === "archived" && l.image_paths.length === 0, l?.status);
    const pub = await fetch(`${API}/listings/${mine}`);
    check("…and no longer public", pub.status === 404, `${pub.status}`);
    const counts = await sql<{ t: string; n: number }[]>`
      select 'saved' t, count(*)::int n from public.saved_listings where user_id = ${leaver.id}
      union all select 'watches', count(*)::int from public.watches where user_id = ${leaver.id}
      union all select 'push', count(*)::int from public.push_devices where user_id = ${leaver.id}
      union all select 'notes', count(*)::int from public.notifications where user_id = ${leaver.id}
      union all select 'sessions', count(*)::int from auth.sessions where user_id = ${leaver.id}`;
    check("saved, watches, push, notes, sessions all gone", counts.every((c) => c.n === 0), JSON.stringify(counts));
    const [u] = await sql<{ deleted_at: Date | null; email: string | null; phone: string | null }[]>`select deleted_at, email, phone from auth.users where id = ${leaver.id}`;
    check("auth user soft-deleted, email scrubbed", !!u?.deleted_at && !(u.email ?? "").includes("clitest+del-a-"), JSON.stringify({ del: !!u?.deleted_at, email: u?.email }));
    const again = await leaver.signIn();
    check("can't sign in again", again.status >= 400, `${again.status}`);
    await sleep(31_000); // the session check is cached ~30s per warm Lambda
    const me = await fetch(`${API}/me`, { headers: H(leaver.token) });
    check("old token rejected", me.status === 401, `${me.status}`);
    const [d] = await sql<{ state: string }[]>`select state from public.deals where id = ${deal}`;
    check("the ended deal is kept", d?.state === "WITHDRAWN", d?.state);
    const buyerDeal = await fetch(`${API}/deals/${deal}`, { headers: H(buyer.token) });
    check("…and the buyer can still open it", buyerDeal.status === 200, `${buyerDeal.status}`);
  } finally {
    await sql.end();
    // The leaver is already soft-deleted; the hard delete fails on the deal's RESTRICT, which is fine.
    for (const id of users) await fetch(`${BASE}/auth/v1/admin/users/${id}`, { method: "DELETE", headers: admin });
  }
  console.log(pass ? "VERDICT → PASS ✅ account deletion (deployed)" : "VERDICT → FAIL ❌");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
