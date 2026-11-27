import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Account → Addresses against the deployed API, with throwaway accounts:
 * first address is the default; adding with isDefault moves it; set-as-default;
 * removing the default promotes the oldest; edit; area validation; the 10 limit;
 * another user can't read, edit or delete yours; concurrent adds keep one default.
 *
 *   API_URL=https://…execute-api… npx tsx scripts/test-cloud-addresses.ts
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
const API = process.env.API_URL!.replace(/\/$/, "");
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "Content-Type": "application/json" };
let pass = true;
const check = (l: string, ok: boolean, extra = "") => { if (!ok) pass = false; console.log(`   ${ok ? "✓" : "✗"} ${l}${extra ? ` — ${extra}` : ""}`); };
type U = { id: string; token: string };
type A = { id: string; label: string; line: string; state: string | null; city: string | null; isDefault: boolean };

async function newUser(tag: string): Promise<U> {
  const email = `clitest+addr-${tag}${Date.now()}@wcp-test.local`;
  const password = `Test-${randomUUID()}9!`;
  const { id } = (await (await fetch(`${BASE}/auth/v1/admin/users`, { method: "POST", headers: admin, body: JSON.stringify({ email, password, email_confirm: true }) })).json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  return { id, token: ((await si.json()) as { access_token: string }).access_token };
}
const call = (u: U, method: string, path: string, body?: unknown) =>
  fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${u.token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async (u: U) => (await (await call(u, "GET", "/me/addresses")).json()) as A[];
const defaults = (xs: A[]) => xs.filter((a) => a.isDefault);

async function main() {
  const me = await newUser("me"), other = await newUser("other");
  try {
    console.log("add / default");
    const r1 = await call(me, "POST", "/me/addresses", { label: "Home", line: "12 Herbert Macaulay Way", state: "Lagos", city: "Yaba" });
    const home = (await r1.json()) as A;
    check("first address → 201 and the default", r1.status === 201 && home.isDefault, `${r1.status}`);
    const office = (await (await call(me, "POST", "/me/addresses", { label: "Office", line: "3 Adeola Odeku St" })).json()) as A;
    check("second address isn't the default", !office.isDefault);
    const shop = (await (await call(me, "POST", "/me/addresses", { label: "Shop", line: "Wuse Market", isDefault: true })).json()) as A;
    let xs = await list(me);
    check("adding with isDefault moves the default (exactly one)", shop.isDefault && defaults(xs).length === 1 && defaults(xs)[0]!.id === shop.id);
    check("list puts the default first", xs[0]?.id === shop.id);

    console.log("set default / edit");
    await call(me, "PATCH", `/me/addresses/${office.id}`, { isDefault: true });
    xs = await list(me);
    check("set as default → only that one is default", defaults(xs).length === 1 && defaults(xs)[0]!.id === office.id);
    const ed = await call(me, "PATCH", `/me/addresses/${home.id}`, { label: "Home 2", line: "14 Herbert Macaulay Way" });
    const edj = (await ed.json()) as A;
    check("edit keeps the area when it isn't sent", ed.status === 200 && edj.label === "Home 2" && edj.city === "Yaba" && edj.state === "Lagos");
    const unset = await call(me, "PATCH", `/me/addresses/${office.id}`, { isDefault: false });
    xs = await list(me);
    check("unsetting the only default leaves a default", unset.status === 200 && defaults(xs).length === 1);

    console.log("validation");
    const badArea = await call(me, "POST", "/me/addresses", { label: "X", line: "Y", state: "Lagos", city: "Not A Real Place" });
    check("an area not in the region list → 400 invalid_area", badArea.status === 400 && ((await badArea.json()) as { error: string }).error === "invalid_area", `${badArea.status}`);
    const cityOnly = await call(me, "POST", "/me/addresses", { label: "X", line: "Y", city: "Yaba" });
    check("a city without its state → 400", cityOnly.status === 400, `${cityOnly.status}`);
    const empty = await call(me, "POST", "/me/addresses", { label: "", line: "" });
    check("blank label/line → 400", empty.status === 400, `${empty.status}`);
    const long = await call(me, "POST", "/me/addresses", { label: "L".repeat(31), line: "x" });
    check("label over 30 chars → 400", long.status === 400, `${long.status}`);

    console.log("someone else's address");
    const peek = await list(other);
    check("another user doesn't see it", !peek.some((a) => a.id === home.id));
    const steal = await call(other, "PATCH", `/me/addresses/${home.id}`, { label: "mine" });
    check("…can't edit it → 404", steal.status === 404, `${steal.status}`);
    const del = await call(other, "DELETE", `/me/addresses/${home.id}`);
    check("…can't delete it → 404", del.status === 404, `${del.status}`);

    console.log("remove");
    await call(me, "DELETE", `/me/addresses/${office.id}`);
    xs = await list(me);
    check("removing the default promotes the oldest remaining", defaults(xs).length === 1 && defaults(xs)[0]!.id === home.id, defaults(xs)[0]?.label);

    console.log("limit");
    const adds = await Promise.all(Array.from({ length: 10 }, (_, i) => call(me, "POST", "/me/addresses", { label: `L${i}`, line: `Line ${i}`, isDefault: i % 2 === 0 })));
    xs = await list(me);
    check("concurrent adds stop at 10", xs.length === 10 && adds.filter((r) => r.status === 409).length === 2, `${xs.length} saved, ${adds.filter((r) => r.status === 409).length}×409`);
    check("…and still exactly one default", defaults(xs).length === 1, `${defaults(xs).length}`);
  } finally {
    for (const u of [me, other]) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ addresses" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", e); process.exit(1); });
