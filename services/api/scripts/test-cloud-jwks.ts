import { jwtVerify, createRemoteJWKSet, decodeProtectedHeader } from "jose";

// Proves the cloud ES256/JWKS verification path (what auth.ts does for cloud
// tokens). Creates a throwaway email/password user in the cloud project, signs
// in for a real ES256 access token, verifies it against the project JWKS, then
// deletes the user. Run with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env.

const BASE = process.env.SUPABASE_URL!;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY!;

async function main() {
  const email = `clitest+${Date.now()}@wcp-test.local`;
  const password = `Test-${Math.random().toString(36).slice(2)}9!`;
  const admin = { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` };

  const cr = await fetch(`${BASE}/auth/v1/admin/users`, {
    method: "POST",
    headers: { ...admin, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const user = (await cr.json()) as { id: string };
  console.log(`1) create cloud user → ${cr.status} id=${user.id}`);

  const si = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: SERVICE, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const sess = (await si.json()) as { access_token?: string };
  const token = sess.access_token;
  if (!token) {
    console.error("no access_token:", JSON.stringify(sess).slice(0, 200));
    await del(user.id, admin);
    process.exit(1);
  }
  console.log(`2) sign in → ${si.status}; token alg=${decodeProtectedHeader(token).alg}`);

  const jwks = createRemoteJWKSet(new URL(`${BASE}/auth/v1/.well-known/jwks.json`));
  const { payload } = await jwtVerify(token, jwks);
  console.log(`3) JWKS verify OK → sub=${payload.sub} role=${payload.role}`);

  await del(user.id, admin);
  process.exit(0);
}

async function del(id: string, admin: Record<string, string>) {
  const d = await fetch(`${BASE}/auth/v1/admin/users/${id}`, {
    method: "DELETE",
    headers: admin,
  });
  console.log(`4) delete test user → ${d.status}`);
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
