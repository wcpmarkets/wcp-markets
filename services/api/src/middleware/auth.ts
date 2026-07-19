import { createMiddleware } from "hono/factory";
import { verify, decode } from "hono/jwt";

/** The authenticated caller, derived from a verified Supabase JWT. */
export type AuthUser = { sub: string; phone: string | null };

export type AuthEnv = { Variables: { user: AuthUser } };

/**
 * Verifies the `Authorization: Bearer <jwt>` Supabase access token and puts the
 * user on the context. Real verification uses `SUPABASE_JWT_SECRET` (HS256).
 *
 * NOTE: until the secret is wired (local Supabase / M0 deploy), this DECODES the
 * token WITHOUT verifying — dev only, and it says so loudly. Never ship without
 * the secret set.
 */
export const auth = createMiddleware<AuthEnv>(async (c, next) => {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const secret = process.env.SUPABASE_JWT_SECRET;
  try {
    let payload: Record<string, unknown>;
    if (secret) {
      payload = (await verify(token, secret, "HS256")) as Record<
        string,
        unknown
      >;
    } else {
      console.warn(
        "[auth] SUPABASE_JWT_SECRET not set — decoding token WITHOUT verification (dev only).",
      );
      payload = decode(token).payload as Record<string, unknown>;
    }

    const sub = payload.sub;
    if (typeof sub !== "string") return c.json({ error: "unauthorized" }, 401);

    c.set("user", { sub, phone: readPhone(payload) });
    await next();
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
});

function readPhone(payload: Record<string, unknown>): string | null {
  if (typeof payload.phone === "string") return payload.phone;
  const meta = payload.user_metadata;
  if (meta && typeof meta === "object" && "phone" in meta) {
    const p = (meta as Record<string, unknown>).phone;
    if (typeof p === "string") return p;
  }
  return null;
}
