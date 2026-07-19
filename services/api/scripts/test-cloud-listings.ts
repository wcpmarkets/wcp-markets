import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * M1 end-to-end against the DEPLOYED API:
 *   seller: create listing → sign upload URL → PUT a real image → read back
 *   viewer (2nd account): sees the active listing + a working signed image URL
 *   owner-only: PATCH by owner works; PATCH by the viewer is 404
 *   /listings/mine is correctly scoped
 * Cleans up storage objects + both users (listings cascade on user delete).
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

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

let pass = true;
function check(label: string, ok: boolean, extra = "") {
  if (!ok) pass = false;
  console.log(`   ${ok ? "✓" : "✗"} ${label}${extra ? ` — ${extra}` : ""}`);
}

async function newUser(tag: string): Promise<{ id: string; token: string }> {
  const email = `clitest+${tag}${Date.now()}@wcp-test.local`;
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

async function main() {
  if (!BASE || !SERVICE || !API) throw new Error("missing SUPABASE_URL / key / API_URL");

  const seller = await newUser("seller");
  const viewer = await newUser("viewer");
  console.log(`0) seller=${seller.id.slice(0, 8)} viewer=${viewer.id.slice(0, 8)}`);

  // 1) create a listing
  const cr = await fetch(`${API}/listings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${seller.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      category: "phones", title: "iPhone 12 — clean", description: "Barely used",
      priceKobo: 25_000_000, condition: "used", location: "Bayelsa", stock: 1,
    }),
  });
  const listing = (await cr.json()) as { id: string; priceKobo: number; imageUrls: string[] };
  console.log(`1) POST /listings → ${cr.status}`);
  check("created 201", cr.status === 201);
  check("priceKobo round-trips as integer", listing.priceKobo === 25_000_000, String(listing.priceKobo));

  let imagePath = "";
  // 2) sign an upload URL + PUT the image bytes
  const su = await fetch(`${API}/listings/${listing.id}/images`, {
    method: "POST",
    headers: { Authorization: `Bearer ${seller.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ contentType: "image/png" }),
  });
  const up = (await su.json()) as { path: string; uploadUrl: string };
  imagePath = up.path;
  console.log(`2) POST …/images → ${su.status}`);
  check("got upload URL", su.status === 200 && !!up.uploadUrl);
  if (up.uploadUrl) {
    const put = await fetch(up.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: PNG,
    });
    check("PUT image bytes", put.ok, `${put.status}`);
  }

  // 3) viewer (2nd account) reads the active listing
  const gv = await fetch(`${API}/listings/${listing.id}`);
  const view = (await gv.json()) as { imageUrls: string[]; title: string };
  console.log(`3) GET /listings/{id} (public) → ${gv.status}`);
  check("viewer sees listing", gv.status === 200);
  check("has 1 signed image URL", view.imageUrls?.length === 1);
  if (view.imageUrls?.[0]) {
    const img = await fetch(view.imageUrls[0]);
    const bytes = Buffer.from(await img.arrayBuffer());
    check("signed image URL resolves to bytes", img.ok && bytes.length === PNG.length, `${img.status}, ${bytes.length}b`);
  }

  // 4) appears in public browse
  const br = await fetch(`${API}/listings?limit=50`);
  const page = (await br.json()) as { items: { id: string }[] };
  check("listing in public browse", page.items?.some((i) => i.id === listing.id));

  // 5) owner-only mutation
  const pOwner = await fetch(`${API}/listings/${listing.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${seller.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ priceKobo: 22_000_000, title: "iPhone 12 — price drop" }),
  });
  const edited = (await pOwner.json()) as { priceKobo: number; title: string };
  console.log(`5) PATCH by owner → ${pOwner.status}`);
  check("owner edit applied", pOwner.status === 200 && edited.priceKobo === 22_000_000);

  const pViewer = await fetch(`${API}/listings/${listing.id}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${viewer.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ priceKobo: 1 }),
  });
  check("non-owner PATCH is 404", pViewer.status === 404, `${pViewer.status}`);

  // 6) /mine scoping
  const mineS = await fetch(`${API}/listings/mine`, { headers: { Authorization: `Bearer ${seller.token}` } });
  const mineV = await fetch(`${API}/listings/mine`, { headers: { Authorization: `Bearer ${viewer.token}` } });
  const sList = (await mineS.json()) as { id: string }[];
  const vList = (await mineV.json()) as { id: string }[];
  check("seller /mine has the listing", sList.some((l) => l.id === listing.id));
  check("viewer /mine does not", !vList.some((l) => l.id === listing.id));

  // cleanup: storage object, then both users (listings cascade)
  if (imagePath) {
    await fetch(`${BASE}/storage/v1/object/listing-images/${imagePath}`, { method: "DELETE", headers: admin });
  }
  for (const u of [seller, viewer]) {
    await fetch(`${BASE}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers: admin });
  }
  console.log(`\nVERDICT → ${pass ? "PASS ✅ M1 Goods listings + Storage work end-to-end" : "FAIL ❌"}`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
