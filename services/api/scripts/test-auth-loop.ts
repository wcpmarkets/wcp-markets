import { sign } from "hono/jwt";
import { createApp } from "../src/app.js";

// End-to-end auth loop against LOCAL Supabase (run with --env-file=.env):
// create a phone user (admin API) → mint its JWT → hit /me in-process → the
// middleware verifies the JWT and upserts+reads the profile. Also exercises the
// OTP endpoint (now that SUPABASE_URL + DB are configured).

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET!;

async function main() {
  const app = createApp();
  const phone = `+2348${Date.now().toString().slice(-9)}`;

  // 1) Create a confirmed phone user via the admin API.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE,
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ phone, phone_confirm: true }),
  });
  const user = (await createRes.json()) as { id: string; phone: string };
  console.log(`1) admin create user → ${createRes.status}  id=${user.id}  phone=${user.phone}`);

  // 2) Mint a Supabase-style access token for that user.
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: user.id, role: "authenticated", aud: "authenticated", phone, iat: now, exp: now + 3600 },
    JWT_SECRET,
    "HS256",
  );
  console.log(`2) minted JWT (${token.slice(0, 24)}…)`);

  // 3) /me WITHOUT a token → 401.
  const noAuth = await app.request("/me");
  console.log(`3) GET /me (no token) → ${noAuth.status} (expect 401)`);

  // 4) /me WITH the token → verifies + upserts the profile.
  const meRes = await app.request("/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`4) GET /me (authed) → ${meRes.status}`, await meRes.json());

  // 5) OTP request — now forwards to local Supabase Auth + is rate-limited.
  const otp1 = await app.request("/auth/otp/request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: "+2348090000001" }),
  });
  console.log(`5) POST /auth/otp/request → ${otp1.status}`, await otp1.json());

  // 6) Hammer the OTP endpoint to prove the per-phone rate limit (limit 3 / 15m).
  let limited = 0;
  for (let i = 0; i < 5; i++) {
    const r = await app.request("/auth/otp/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone: "+2348090000002" }),
    });
    if (r.status === 429) limited++;
  }
  console.log(`6) OTP rate limit: ${limited}/5 requests blocked with 429 (expect ≥2)`);

  process.exit(0);
}

main().catch((e) => {
  console.error("test failed:", e);
  process.exit(1);
});
