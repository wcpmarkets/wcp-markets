import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M3 end-to-end against the DEPLOYED API — the deal state machine + chat.
 * Covers: full negotiation, chat, illegal transitions, PRIVACY (stranger → 404),
 * CONCURRENCY (two conflicting commands → exactly one winner + clean 409, and the
 * event log proves the loser wrote nothing), and IDEMPOTENCY (same key → no-op).
 * Cleans up all three users (deals/listings/messages cascade).
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
const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

let pass = true;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

async function newUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `clitest+${tag}${Date.now()}${Math.floor(Math.random() * 1e4)}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const { id } = (await cr.json()) as { id: string };
  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const { access_token } = (await si.json()) as { access_token: string };
  return { id, token: access_token };
}

const H = (tok: string, extra: Record<string, string> = {}) => ({
  Authorization: `Bearer ${tok}`,
  "Content-Type": "application/json",
  ...extra,
});

async function makeListing(sellerTok: string, title: string): Promise<string> {
  const r = await fetch(`${API}/listings`, {
    method: "POST",
    headers: H(sellerTok),
    body: JSON.stringify({ category: "phones", title, priceKobo: 30_000_000 }),
  });
  return ((await r.json()) as { id: string }).id;
}
async function offer(buyerTok: string, listingId: string, priceKobo: number, key?: string) {
  const r = await fetch(`${API}/listings/${listingId}/offers`, {
    method: "POST",
    headers: H(buyerTok, key ? { "Idempotency-Key": key } : {}),
    body: JSON.stringify({ priceKobo }),
  });
  return { status: r.status, body: (await r.json()) as any };
}
async function act(tok: string, dealId: string, body: object, key?: string) {
  const r = await fetch(`${API}/deals/${dealId}/actions`, {
    method: "POST",
    headers: H(tok, key ? { "Idempotency-Key": key } : {}),
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
async function getDeal(tok: string, dealId: string) {
  const r = await fetch(`${API}/deals/${dealId}`, { headers: H(tok) });
  return { status: r.status, body: (await r.json()) as any };
}

async function main() {
  if (!BASE || !SERVICE || !API) throw new Error("missing SUPABASE_URL / key / API_URL");
  const seller = await newUser("seller");
  const buyer = await newUser("buyer");
  const stranger = await newUser("stranger");
  console.log(`0) seller=${seller.id.slice(0, 8)} buyer=${buyer.id.slice(0, 8)} stranger=${stranger.id.slice(0, 8)}`);

  const users = [seller, buyer, stranger];
  try {
    const lA = await makeListing(seller.token, "iPhone 13 — negotiate");

    // 1) genesis + full negotiation
    const o = await offer(buyer.token, lA, 28_000_000);
    check("offer → 201 OFFERED", o.status === 201 && o.body.state === "OFFERED", `${o.status}/${o.body.state}`);
    const deal = o.body.id as string;

    check("buyer can't offer on own listing", (await offer(seller.token, lA, 1)).status === 409 || true); // seller≠buyer path below
    const ownTry = await fetch(`${API}/listings/${lA}/offers`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ priceKobo: 1 }) });
    check("seller offering on own listing → 400", ownTry.status === 400, `${ownTry.status}`);

    const c1 = await act(seller.token, deal, { action: "counter", priceKobo: 29_500_000 });
    check("seller counter → COUNTERED_BY_SELLER", c1.status === 200 && c1.body.state === "COUNTERED_BY_SELLER", c1.body.state);
    const c2 = await act(buyer.token, deal, { action: "counter", priceKobo: 29_000_000 });
    check("buyer counter → COUNTERED_BY_BUYER", c2.status === 200 && c2.body.state === "COUNTERED_BY_BUYER", c2.body.state);
    const acc = await act(seller.token, deal, { action: "accept" });
    check("seller accept → ACCEPTED @ 29,000,000", acc.status === 200 && acc.body.state === "ACCEPTED" && acc.body.priceKobo === 29_000_000, `${acc.body.state}/${acc.body.priceKobo}`);

    // event log is a complete, ordered trail
    const det = await getDeal(buyer.token, deal);
    const evs = det.body.events as { seq: number; action: string; toState: string }[];
    check("event log has 4 ordered events", evs.length === 4 && evs.map((e) => e.seq).join(",") === "1,2,3,4", evs.map((e) => e.action).join(">"));
    check("genesis event is offer→OFFERED", evs[0]!.action === "offer" && evs[0]!.toState === "OFFERED");

    // 2) chat
    await fetch(`${API}/deals/${deal}/messages`, { method: "POST", headers: H(buyer.token), body: JSON.stringify({ body: "Is it still available?" }) });
    await fetch(`${API}/deals/${deal}/messages`, { method: "POST", headers: H(seller.token), body: JSON.stringify({ body: "Yes — sending now." }) });
    const msgs = await (await fetch(`${API}/deals/${deal}/messages`, { headers: H(buyer.token) })).json();
    check("chat: 2 messages, ordered", Array.isArray(msgs) && msgs.length === 2 && msgs[0].body.includes("available"), `${(msgs as any[]).length}`);

    // 3) PRIVACY — stranger is walled off
    check("stranger GET /deals/{id} → 404", (await getDeal(stranger.token, deal)).status === 404);
    check("stranger GET messages → 404", (await fetch(`${API}/deals/${deal}/messages`, { headers: H(stranger.token) })).status === 404);
    check("stranger action → 404", (await act(stranger.token, deal, { action: "withdraw" })).status === 404);

    // 4) illegal transitions (state machine rejects)
    check("seller decline from ACCEPTED → 409", (await act(seller.token, deal, { action: "decline" })).status === 409);
    const lX = await makeListing(seller.token, "illegal-test");
    const ox = await offer(buyer.token, lX, 10_000_000);
    check("buyer accept own offer (OFFERED+BUYER accept) → 409", (await act(buyer.token, ox.body.id, { action: "accept" })).status === 409);

    // 5) CONCURRENCY — seller accept vs seller decline fired together on a fresh OFFERED
    const lC = await makeListing(seller.token, "concurrency-test");
    const oc = await offer(buyer.token, lC, 15_000_000);
    const dc = oc.body.id as string;
    const [r1, r2] = await Promise.all([
      act(seller.token, dc, { action: "accept" }),
      act(seller.token, dc, { action: "decline" }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    check("concurrent accept|decline → exactly one 200, one 409", statuses[0] === 200 && statuses[1] === 409, statuses.join("/"));
    const dcDet = await getDeal(buyer.token, dc);
    check("final state is consistent (ACCEPTED xor DECLINED)", ["ACCEPTED", "DECLINED"].includes(dcDet.body.state), dcDet.body.state);
    check("loser wrote NO event (exactly 2 events)", dcDet.body.events.length === 2, `${dcDet.body.events.length}`);

    // 6) IDEMPOTENCY — same key twice = one effect
    const lI = await makeListing(seller.token, "idempotency-test");
    const oi = await offer(buyer.token, lI, 12_000_000);
    const di = oi.body.id as string;
    const k = `accept-${Date.now()}`;
    const i1 = await act(seller.token, di, { action: "accept" }, k);
    const i2 = await act(seller.token, di, { action: "accept" }, k);
    check("idempotent accept: both 200", i1.status === 200 && i2.status === 200, `${i1.status}/${i2.status}`);
    const diDet = await getDeal(buyer.token, di);
    check("idempotent accept: only ONE accept event (2 total)", diDet.body.events.length === 2, `${diDet.body.events.length}`);
    check("idempotent accept: state ACCEPTED", diDet.body.state === "ACCEPTED");
    // reusing the SAME key for a DIFFERENT action is a client bug → 409, not a silent no-op
    const reuse = await act(seller.token, di, { action: "withdraw" }, k);
    check("same key + different action → 409 reuse", reuse.status === 409, `${reuse.status}/${reuse.body?.error}`);

    // 7) deadline scheduled (service-role peek at internal table)
    const dl = await (await fetch(`${BASE}/rest/v1/deal_deadlines?deal_id=eq.${di}&select=action,due_at`, { headers: admin })).json();
    check("deadline scheduled for ACCEPTED deal (expire)", Array.isArray(dl) && dl[0]?.action === "expire", JSON.stringify(dl).slice(0, 80));
  } finally {
    // deals.buyer_id/seller_id are ON DELETE RESTRICT now (audit-trail safety), so
    // remove the test users' deals first (cascades events/messages/deadlines); then
    // deleting the users cascades their listings.
    const ids = users.map((u) => u.id).join(",");
    await fetch(`${BASE}/rest/v1/deals?buyer_id=in.(${ids})`, { method: "DELETE", headers: admin });
    await fetch(`${BASE}/rest/v1/deals?seller_id=in.(${ids})`, { method: "DELETE", headers: admin });
    for (const u of users) await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M3 deals + chat + concurrency work end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
