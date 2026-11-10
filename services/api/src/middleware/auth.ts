import { createMiddleware } from "hono/factory";
import {
  jwtVerify,
  createRemoteJWKSet,
  decodeProtectedHeader,
  type JWTPayload,
} from "jose";
import { getDb } from "../db.js";

/** The authenticated caller, derived from a verified Supabase JWT. */
export type AuthUser = { sub: string; phone: string | null; sessionId: string | null };

export type AuthEnv = { Variables: { user: AuthUser } };

// Supabase issues either symmetric (HS256, legacy / local dev) or asymmetric
// (ES256/RS256 via JWKS, current cloud default) tokens. We verify by the token's
// own `alg`: HS256 against SUPABASE_JWT_SECRET; anything else against the
// project's JWKS. The remote JWKS is fetched + cached by jose.
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function getJwks() {
  if (jwks) return jwks;
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  jwks = createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`));
  return jwks;
}

/**
 * Verify a Supabase access token. Returns the caller, or null for any invalid token.
 * Shared by the `auth` middleware and public routes that personalise when signed in.
 */
export async function verifyAccessToken(token: string): Promise<AuthUser | null> {
  let alg: string | undefined;
  try {
    alg = decodeProtectedHeader(token).alg;
  } catch {
    return null;
  }

  // Pin the audience (Supabase user tokens are aud="authenticated") and issuer
  // (the project's /auth/v1) so verification is deliberate, not incidentally saved
  // by the sub check — a token minted for another aud/issuer is rejected outright.
  const url = process.env.SUPABASE_URL?.replace(/\/$/, "");
  const verifyOpts = {
    audience: "authenticated",
    ...(url ? { issuer: `${url}/auth/v1` } : {}),
  };

  try {
    let payload: JWTPayload;
    if (alg === "HS256") {
      const secret = process.env.SUPABASE_JWT_SECRET;
      if (!secret) throw new Error("HS256 token but SUPABASE_JWT_SECRET unset");
      ({ payload } = await jwtVerify(token, new TextEncoder().encode(secret), verifyOpts));
    } else {
      const keys = getJwks();
      if (!keys) throw new Error("asymmetric token but SUPABASE_URL unset");
      ({ payload } = await jwtVerify(token, keys, verifyOpts));
    }
    const sub = payload.sub;
    if (typeof sub !== "string") return null;
    const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
    if (!(await sessionAlive(sub, sessionId))) return null;
    return { sub, phone: readPhone(payload), sessionId };
  } catch {
    return null;
  }
}

/**
 * A signed JWT outlives the session it came from (up to its 1h expiry). "Sign out
 * other devices" and an account-recovery transfer delete rows from auth.sessions, so
 * the API checks the token's session still exists — otherwise a revoked phone keeps
 * working until its token expires. Cached ~30s per warm Lambda (a revoke takes at most
 * that long to bite). No DB (local dev) or no session_id claim (legacy/test tokens) →
 * not checked.
 */
const SESSION_TTL_MS = 30_000;
const sessionCache = new Map<string, number>(); // session id → alive-until (ms)
async function sessionAlive(sub: string, sessionId: string | null): Promise<boolean> {
  if (!sessionId) return true;
  const until = sessionCache.get(sessionId);
  if (until && until > Date.now()) return true;
  const db = await getDb();
  if (!db) return true;
  const [row] = await db`
    select 1 from auth.sessions
    where id = ${sessionId} and user_id = ${sub} and (not_after is null or not_after > now())`;
  if (!row) {
    sessionCache.delete(sessionId);
    return false;
  }
  if (sessionCache.size > 5000) sessionCache.clear();
  sessionCache.set(sessionId, Date.now() + SESSION_TTL_MS);
  return true;
}

/** Forget a session at once (this Lambda's cache) — after the caller revokes it. */
export function forgetSession(sessionId: string): void {
  sessionCache.delete(sessionId);
}

export const auth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);
  const user = await verifyAccessToken(token);
  if (!user) return c.json({ error: "unauthorized" }, 401);
  c.set("user", user);
  await next();
});

function readPhone(payload: JWTPayload): string | null {
  if (typeof payload.phone === "string") return payload.phone;
  const meta = payload.user_metadata;
  if (meta && typeof meta === "object" && "phone" in meta) {
    const p = (meta as Record<string, unknown>).phone;
    if (typeof p === "string") return p;
  }
  return null;
}
