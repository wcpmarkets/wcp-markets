import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { getDb } from "../db.js";

/** Best-effort client IP from proxy headers (Function URL / API GW set these). */
export function clientIp(c: Context): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return c.req.header("x-real-ip") ?? "unknown";
}

/**
 * Fixed-window rate limit backed by `consume_rate_limit` (migration 0003). Blocks
 * with 429 when any of the derived bucket keys exceeds `limit` in `windowSecs`.
 * If there's no DB (local dev), it no-ops with a warning.
 *
 * Used to throttle the OTP path — a bare SMS-sending endpoint is an SMS-pumping
 * target, so we cap per-phone AND per-IP.
 */
export function rateLimit(opts: {
  prefix: string;
  limit: number;
  windowSecs: number;
  keys: (c: Context) => string[];
}) {
  return createMiddleware(async (c, next) => {
    const db = await getDb();
    if (!db) {
      console.warn(`[rate-limit] no DB — '${opts.prefix}' not enforced (dev).`);
      return next();
    }
    for (const key of opts.keys(c)) {
      const bucket = `${opts.prefix}:${key}`;
      const rows = await db<{ allowed: boolean }[]>`
        select public.consume_rate_limit(${bucket}, ${opts.limit}, ${opts.windowSecs}) as allowed
      `;
      if (!rows[0]?.allowed) {
        return c.json({ error: "rate_limited" }, 429);
      }
    }
    return next();
  });
}
