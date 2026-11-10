import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Phase 3 G live — account recovery + signed-in devices on the DEPLOYED API
 * (20j-recover-1…4, 20m-privacy):
 *   • start: needs a signed-in, EMPTY account on the new number; bad/own/unknown numbers
 *     are refused; one open request per account
 *   • basic branch: last order (+ decoys + "I haven't ordered yet") and the email;
 *     wrong → an attempt used; 3 wrong → failed; right → 24h hold, SMS to both numbers
 *   • seller branch: the same BVN/NIN matched by keyed hash (a different valid ID fails)
 *   • nothing to ask (no email, no orders) → admin review → approve → hold
 *   • the owner sees the banner and cancels; the requester can cancel too
 *   • transfer (the sweeper, once the hold runs out): the placeholder is deleted, the
 *     account takes the new number, its old sessions are revoked at the API
 *   • devices: list (one is "current"), sign out one, sign out all others
 *
 * Test numbers are 234700xxxxxxx. SMS must be MOCKED: the suite refuses to run if a
 * Termii key exists in SSM, so it can never text a real person.
 *
 *   API_URL=https://… npx tsx scripts/test-cloud-recovery.ts
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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const j = async <T>(r: Response) => (await r.json()) as T;
const api = (path: string, t: string, init: RequestInit = {}) => fetch(`${API}${path}`, { ...init, headers: H(t) });
const post = (path: string, t: string, body?: unknown) => api(path, t, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const err = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "";

const testPhone = () => `234700${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
type U = { id: string; token: string; phone: string | null; email: string | null; password: string };
async function signIn(u: { email: string | null; phone: string | null; password: string }): Promise<string> {
  const body = u.email ? { email: u.email, password: u.password } : { phone: u.phone, password: u.password };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: SERVICE, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const t = ((await si.json()) as { access_token?: string }).access_token;
  if (!t) throw new Error(`sign-in failed (${si.status})`);
  return t;
}
async function newUser(tag: string, opts: { email?: boolean } = {}): Promise<U> {
  const email = opts.email === false ? null : `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const phone = testPhone();
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ ...(email ? { email, email_confirm: true } : {}), phone, phone_confirm: true, password }),
  });
  const { id } = (await cr.json()) as { id: string };
  if (!id) throw new Error(`create user failed (${cr.status})`);
  return { id, phone, email, password, token: await signIn({ email, phone, password }) };
}
type Q = { id: string; kind: "choice" | "text"; options: { id: string; label: string }[] | null; hint: string | null };
type Rec = { id: string; status: string; branch: string; accountName: string | null; lostPhone: string; newPhone: string; questions: Q[]; attemptsLeft: number; holdUntil: string | null; closedReason: string | null };
type Sess = { id: string; device: string; current: boolean; ip: string | null };

async function main() {
  // Never text a real person: this suite only runs while SMS is mocked.
  if (await fetchSsm("/wcp/api/termii-api-key")) {
    console.error("A Termii key exists in SSM — refusing to run (test numbers could be real). Run against the mock only.");
    process.exit(2);
  }
  const dbUrl = process.env.DATABASE_URL ?? (await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url"));
  const sql = postgres(dbUrl!, { prepare: false, max: 2 });
  const users: U[] = [];
  const mk = async (tag: string, o?: { email?: boolean }) => { const u = await newUser(tag, o); users.push(u); return u; };
  const recIds: string[] = [];
  const sms = async (recId: string) =>
    sql<{ to_phone: string; kind: string; provider: string; status: string }[]>`select to_phone, kind, provider, status from public.sms_log where recovery_id = ${recId} order by id`;
  const rowOf = async (id: string) => (await sql<{ status: string; hold_until: Date | null; closed_reason: string | null }[]>`select status, hold_until, closed_reason from public.account_recoveries where id = ${id}`)[0];

  // Repeated runs from one machine trip the per-IP recovery limits (by design). Reset
  // only THIS machine's recovery buckets — its IP as Supabase recorded it for a test session.
  let myIp: string | null = null;
  const resetMyLimits = async () => {
    if (!myIp) return;
    await sql`delete from public.rate_limits where bucket in (${"recovery:start:ip:" + myIp}, ${"recovery:answer:ip:" + myIp})`;
  };

  try {
    // ── 1. Start: guards ─────────────────────────────────────────────────────
    console.log("1. Start — guards");
    const owner = await mk("rc-own");                 // the account being recovered (has an email)
    await api("/me", owner.token);                    // profile row
    await sql`update public.profiles set display_name = 'Musa Abdullahi' where id = ${owner.id}`;
    const req1 = await mk("rc-r1");                   // signed in on the "new" number
    myIp = (await sql<{ ip: string }[]>`select split_part(ip::text, '/', 1) as ip from auth.sessions where user_id = ${req1.id} and ip is not null limit 1`)[0]?.ip ?? null;
    await resetMyLimits();
    let r = await post("/recovery", req1.token, { lostPhone: "12345" });
    check("not a Nigerian mobile → 400", r.status === 400, `${r.status} ${await err(r)}`);
    r = await post("/recovery", req1.token, { lostPhone: `+${req1.phone}` });
    check("your own number → 409 same_number", r.status === 409 && (await err(r)) === "same_number");
    r = await post("/recovery", req1.token, { lostPhone: `0${testPhone().slice(3)}` });
    check("no account on that number → 404", r.status === 404, `${r.status}`);
    const busy = await mk("rc-busy");
    await post("/kyc/verify", busy.token, { idType: "nin", idNumber: "12345678901" });
    r = await post("/recovery", busy.token, { lostPhone: owner.phone });
    check("a requester account with activity → 409 not_fresh", r.status === 409 && (await err(r)) === "not_fresh");

    // ── 2. Basic branch ──────────────────────────────────────────────────────
    console.log("2. Basic branch — account questions");
    r = await post("/recovery", req1.token, { lostPhone: `0${owner.phone!.slice(3)}` }); // local format
    const rec1 = await j<Rec>(r);
    if (rec1.id) recIds.push(rec1.id);
    check("starts (local 0… format accepted) → 201 identity/basic", r.status === 201 && rec1.status === "identity" && rec1.branch === "basic", `${r.status} ${rec1.status}/${rec1.branch}`);
    check("account shown only masked", rec1.accountName === "M•••• A." && !JSON.stringify(rec1).includes(owner.phone!) && !JSON.stringify(rec1).includes(owner.email!), rec1.accountName ?? "");
    const order = rec1.questions.find((q) => q.id === "last_order");
    const emailQ = rec1.questions.find((q) => q.id === "email");
    check("asks the last order with 'I haven't ordered yet'", !!order?.options?.some((o) => o.id === "none"));
    check("asks the email, hinted masked", !!emailQ && /^c•••.@wcp-test\.local$/.test(emailQ.hint ?? ""), emailQ?.hint ?? "");
    check("no answer key leaks to the client", !JSON.stringify(rec1).includes('"answer"'));
    r = await post("/recovery", req1.token, { lostPhone: owner.phone });
    check("asking again resumes the same request", r.status === 201 && (await j<Rec>(r)).id === rec1.id);
    const req1b = await mk("rc-r1b");
    r = await post("/recovery", req1b.token, { lostPhone: owner.phone });
    check("a second requester for the same account → 409 in_progress", r.status === 409 && (await err(r)) === "in_progress");
    r = await post(`/recovery/${rec1.id}/answer`, req1b.token, { answers: [] });
    check("someone else's request → 404", r.status === 404);
    r = await post(`/recovery/${rec1.id}/answer`, req1.token, { answers: [{ questionId: "last_order", value: "none" }] });
    check("a missing answer → 400", r.status === 400 && (await err(r)) === "missing_answer");
    r = await post(`/recovery/${rec1.id}/answer`, req1.token, { answers: [{ questionId: "last_order", value: "none" }, { questionId: "email", value: "wrong@x.com" }] });
    let ans = await j<{ correct: boolean; recovery: Rec }>(r);
    check("wrong email → attempt used, 2 left", r.status === 200 && !ans.correct && ans.recovery.attemptsLeft === 2 && ans.recovery.status === "identity");
    check("owner sees nothing yet (no banner at the question step)", (await j<{ recovery: unknown }>(await api("/me/recovery", owner.token))).recovery === null);
    r = await post(`/recovery/${rec1.id}/answer`, req1.token, { answers: [{ questionId: "last_order", value: "none" }, { questionId: "email", value: ` ${owner.email!.toUpperCase()} ` }] });
    ans = await j<{ correct: boolean; recovery: Rec }>(r);
    check("right answers (email case/space-insensitive) → holding", ans.correct && ans.recovery.status === "holding" && !!ans.recovery.holdUntil);
    const holdH = (new Date(ans.recovery.holdUntil!).getTime() - Date.now()) / 3_600_000;
    check("hold is 24h", holdH > 23.9 && holdH <= 24.01, holdH.toFixed(2));
    let log = await sms(rec1.id);
    check("SMS to the old AND the new number (mocked)", log.some((l) => l.to_phone === owner.phone && l.kind === "recovery_started") && log.some((l) => l.to_phone === req1.phone && l.kind === "recovery_started") && log.every((l) => l.provider === "mock" && l.status === "mocked"), JSON.stringify(log.map((l) => `${l.kind}:${l.status}`)));
    r = await post(`/recovery/${rec1.id}/answer`, req1.token, { answers: [{ questionId: "last_order", value: "none" }, { questionId: "email", value: owner.email }] });
    check("answering again while holding → 409", r.status === 409);

    // ── 3. Owner banner + cancel ─────────────────────────────────────────────
    console.log("3. The owner sees it and cancels");
    const banner = await j<{ recovery: { id: string; status: string; newPhone: string } | null }>(await api("/me/recovery", owner.token));
    check("owner's banner: holding, new number masked", banner.recovery?.id === rec1.id && banner.recovery.status === "holding" && banner.recovery.newPhone.endsWith(req1.phone!.slice(-4)) && !banner.recovery.newPhone.includes(req1.phone!));
    r = await post("/me/recovery/cancel", owner.token);
    check("owner cancels → 200", r.status === 200, `${r.status}`);
    check("request is cancelled (by owner)", (await rowOf(rec1.id))?.status === "cancelled" && (await rowOf(rec1.id))?.closed_reason === "owner");
    log = await sms(rec1.id);
    check("cancellation SMS to both numbers", log.filter((l) => l.kind === "recovery_cancelled").length === 2);
    const mine = await j<Rec>(await api("/recovery", req1.token));
    check("requester sees it cancelled", mine.status === "cancelled" && mine.closedReason === "owner");

    // ── 4. Three wrong answers → failed ──────────────────────────────────────
    console.log("4. Attempts run out");
    const req2 = await mk("rc-r2");
    const rec2 = await j<Rec>(await post("/recovery", req2.token, { lostPhone: owner.phone }));
    recIds.push(rec2.id);
    for (let i = 0; i < 3; i++) ans = await j(await post(`/recovery/${rec2.id}/answer`, req2.token, { answers: [{ questionId: "last_order", value: "o1" }, { questionId: "email", value: "nope@x.com" }] }));
    check("3rd wrong answer → failed (attempts)", ans.recovery.status === "failed" && ans.recovery.attemptsLeft === 0 && ans.recovery.closedReason === "attempts");

    // ── 5. Seller branch — the same ID, by keyed hash ────────────────────────
    console.log("5. Seller branch — BVN/NIN re-match");
    const seller = await mk("rc-sel");
    r = await post("/kyc/verify", seller.token, { idType: "bvn", idNumber: "22233344455" });
    check("seller verifies (L2)", r.status === 200 && (await j<{ level: number }>(r)).level === 2);
    const [kh] = await sql<{ id_hash: string | null }[]>`select id_hash from public.kyc_verifications where user_id = ${seller.id}`;
    check("a keyed hash is stored, not the number", /^[0-9a-f]{64}$/.test(kh?.id_hash ?? "") && kh!.id_hash !== "22233344455");
    const req3 = await mk("rc-r3");
    const rec3 = await j<Rec>(await post("/recovery", req3.token, { lostPhone: seller.phone }));
    recIds.push(rec3.id);
    check("seller account → seller branch, no questions", rec3.branch === "seller" && rec3.status === "identity" && rec3.questions.length === 0);
    r = await post(`/recovery/${rec3.id}/answer`, req3.token, {});
    check("no ID → 400", r.status === 400);
    ans = await j(await post(`/recovery/${rec3.id}/answer`, req3.token, { idType: "bvn", idNumber: "99988877766" }));
    check("a different (valid) BVN → wrong", !ans.correct && ans.recovery.attemptsLeft === 2);
    ans = await j(await post(`/recovery/${rec3.id}/answer`, req3.token, { idType: "nin", idNumber: "22233344455" }));
    check("same digits as NIN, not BVN → wrong", !ans.correct && ans.recovery.attemptsLeft === 1);
    ans = await j(await post(`/recovery/${rec3.id}/answer`, req3.token, { idType: "bvn", idNumber: "222 333 444 55" }));
    check("the same BVN → holding", ans.correct && ans.recovery?.status === "holding", JSON.stringify(ans).slice(0, 160));
    r = await post(`/recovery/${rec3.id}/cancel`, req3.token);
    check("requester cancels their own → cancelled", r.status === 200 && (await j<Rec>(r)).status === "cancelled");

    // ── 6. Nothing to ask → admin review ─────────────────────────────────────
    console.log("6. Admin review");
    const bare = await mk("rc-bare", { email: false });  // phone only, no orders
    const staff = await mk("rc-adm");
    await sql`insert into public.staff_roles (user_id, role) values (${staff.id}, 'admin') on conflict do nothing`;
    const req4 = await mk("rc-r4");
    const rec4 = await j<Rec>(await post("/recovery", req4.token, { lostPhone: bare.phone }));
    recIds.push(rec4.id);
    check("no email, no orders → review", rec4.status === "review" && rec4.questions.length === 0, rec4.status);
    check("review alerts the old number", (await sms(rec4.id)).some((l) => l.kind === "recovery_review" && l.to_phone === bare.phone));
    check("owner's banner shows review", (await j<{ recovery: { status: string } | null }>(await api("/me/recovery", bare.token))).recovery?.status === "review");
    r = await api("/admin/recoveries", req4.token);
    check("non-admin can't list → 403", r.status === 403);
    const queue = await j<{ id: string; lostPhone: string }[]>(await api("/admin/recoveries", staff.token));
    check("admin queue lists it, numbers masked", queue.some((q) => q.id === rec4.id && !q.lostPhone.includes(bare.phone!)));
    r = await post(`/admin/recoveries/${rec4.id}/approve`, staff.token);
    check("admin approves → holding", r.status === 200 && (await j<{ status: string }>(r)).status === "holding");
    r = await post(`/admin/recoveries/${rec4.id}/approve`, staff.token);
    check("approve again → 409", r.status === 409);

    // ── 7. Transfer ──────────────────────────────────────────────────────────
    console.log("7. Transfer after the hold (sweeper)");
    const ownerOld = owner.token;
    check("owner's token works before", (await api("/me", ownerOld)).status === 200);
    await sql`update public.account_recoveries set hold_until = now() - interval '1 minute' where id = ${rec4.id}`;
    let done = false;
    for (let i = 0; i < 15 && !done; i++) {
      done = (await rowOf(rec4.id))?.status === "completed";
      if (!done) { await sleep(10_000); process.stdout.write(`   …waiting for the sweeper (${(i + 1) * 10}s)\n`); }
    }
    check("sweeper completed the transfer", done, (await rowOf(rec4.id))?.status ?? "");
    const [moved] = await sql<{ phone: string }[]>`select phone from auth.users where id = ${bare.id}`;
    check("the account now has the new number", moved?.phone === req4.phone);
    const [gone] = await sql`select 1 from auth.users where id = ${req4.id}`;
    check("the placeholder account is deleted", !gone);
    if (!gone) users.splice(users.indexOf(req4), 1); // already deleted by the transfer
    const [sessLeft] = await sql<{ n: number }[]>`select count(*)::int as n from auth.sessions where user_id = ${bare.id}`;
    check("all the account's sessions are gone", sessLeft?.n === 0);
    await sleep(31_000); // the API's session cache
    check("the old device's token is refused (401)", (await api("/me", bare.token)).status === 401);
    const fresh = await signIn({ email: null, phone: req4.phone, password: bare.password });
    const me = await j<{ userId?: string; phone?: string | null }>(await api("/me", fresh));
    check("signing in with the new number lands on the recovered account", me.userId === bare.id && me.phone === req4.phone, `${me.userId === bare.id} ${me.phone}`);
    bare.token = fresh;
    bare.phone = req4.phone;
    log = await sms(rec4.id);
    check("completion SMS to both numbers", log.filter((l) => l.kind === "recovery_completed").length === 2);

    // ── 8. Devices ───────────────────────────────────────────────────────────
    console.log("8. Signed-in devices");
    const dev = await mk("rc-dev");
    const t2 = await signIn(dev);
    const t3 = await signIn(dev);
    let list = await j<Sess[]>(await api("/me/sessions", dev.token));
    check("three sessions listed, exactly one current", list.length === 3 && list.filter((s) => s.current).length === 1, `${list.length}`);
    check("IPs masked", list.every((s) => !s.ip || s.ip.includes("•") || s.ip.endsWith("…")), list.map((s) => s.ip).join(","));
    const others = list.filter((s) => !s.current);
    r = await api(`/me/sessions/${others[0]!.id}`, dev.token, { method: "DELETE" });
    check("sign out one device → 200", r.status === 200);
    r = await api(`/me/sessions/${others[0]!.id}`, dev.token, { method: "DELETE" });
    check("again → 404", r.status === 404);
    r = await api(`/me/sessions/${list.find((s) => s.current)!.id}`, owner.token, { method: "DELETE" });
    check("someone else's session → 404", r.status === 404);
    r = await post("/me/sessions/sign-out-others", dev.token);
    check("sign out all others → 1 more", r.status === 200 && (await j<{ signedOut: number }>(r)).signedOut === 1);
    list = await j<Sess[]>(await api("/me/sessions", dev.token));
    check("only this device remains", list.length === 1 && list[0]!.current);
    await sleep(31_000);
    check("signed-out tokens are refused", (await api("/me", t2)).status === 401 && (await api("/me", t3)).status === 401);
    check("this device still works", (await api("/me", dev.token)).status === 200);
  } finally {
    console.log("cleanup");
    await resetMyLimits();
    for (const id of recIds) await sql`delete from public.sms_log where recovery_id = ${id}`;
    await sql`delete from public.account_recoveries where id = any(${recIds})`;
    for (const u of users) await sql`delete from public.staff_roles where user_id = ${u.id}`;
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
    await sql.end({ timeout: 5 });
  }
  console.log(pass ? "\nALL PASS" : "\nFAILURES");
  process.exit(pass ? 0 : 1);
}
main().catch((e) => { console.error("FAIL", (e as Error).message); process.exit(1); });
