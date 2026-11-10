import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, forgetSession, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";

/**
 * Signed-in devices (20m-privacy): the caller's Supabase Auth sessions, and signing
 * them out. Deleting an auth.sessions row kills its refresh token at once (cascade)
 * and its access token at the API's session check (middleware/auth.ts, ≤30s cache).
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const SessionSchema = z
  .object({
    id: z.string().uuid(),
    device: z.string(),            // a short label from the user agent
    userAgent: z.string().nullable(),
    ip: z.string().nullable(),     // masked to the first two octets
    createdAt: z.string(),
    lastActiveAt: z.string(),
    current: z.boolean(),
  })
  .openapi("Session");
const SignOutResultSchema = z.object({ signedOut: z.number().int() }).openapi("SignOutResult");

type Row = { id: string; user_agent: string | null; ip: string | null; created_at: Date; updated_at: Date | null; refreshed_at: Date | null };

/** "okhttp/4.12.0" → "Android app"; a browser UA → "Chrome on Windows", etc. */
export function deviceLabel(ua: string | null): string {
  if (!ua) return "Unknown device";
  if (/okhttp|ktor|Dalvik/i.test(ua)) return "Android app";
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iOS/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows" : /Mac OS/i.test(ua) ? "Mac" : /Linux/i.test(ua) ? "Linux" : null;
  const br = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : null;
  if (br && os) return `${br} on ${os}`;
  return br ?? os ?? ua.split(/[ /]/)[0]!.slice(0, 40);
}
const maskIp = (ip: string | null) => {
  if (!ip) return null;
  const v4 = ip.match(/^(\d+)\.(\d+)\./);
  if (v4) return `${v4[1]}.${v4[2]}.•.•`;
  return ip.split(":").slice(0, 2).join(":") + ":…";
};
const iso = (d: Date | string) => (typeof d === "string" ? new Date(d) : d).toISOString();

export function registerSessions(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/sessions",
      summary: "Devices signed in to the caller's account",
      tags: ["sessions"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Sessions, most recently active first", content: { "application/json": { schema: z.array(SessionSchema) } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<Row[]>`
        select id, user_agent, split_part(ip::text, '/', 1) as ip, created_at, updated_at, refreshed_at from auth.sessions
        where user_id = ${user.sub} and (not_after is null or not_after > now())
        order by coalesce(refreshed_at, updated_at, created_at) desc limit 50`;
      return c.json(
        rows.map((r) => ({
          id: r.id,
          device: deviceLabel(r.user_agent),
          userAgent: r.user_agent,
          ip: maskIp(r.ip),
          createdAt: iso(r.created_at),
          lastActiveAt: iso(r.refreshed_at ?? r.updated_at ?? r.created_at),
          current: r.id === user.sessionId,
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/sessions/{id}",
      summary: "Sign one device out",
      tags: ["sessions"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Signed out", content: { "application/json": { schema: SignOutResultSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "No such session", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const gone = await db`delete from auth.sessions where id = ${id} and user_id = ${user.sub} returning id`;
      if (!gone.length) return c.json({ error: "not_found" }, 404);
      forgetSession(id);
      return c.json({ signedOut: 1 }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/sessions/sign-out-others",
      summary: "Sign out every device except this one",
      tags: ["sessions"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Signed out", content: { "application/json": { schema: SignOutResultSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "This token has no session to keep", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      // Without a session id we can't tell which one is "this" — refuse rather than
      // sign the caller out too.
      if (!user.sessionId) return c.json({ error: "no_session" }, 409);
      const gone = await db<{ id: string }[]>`
        delete from auth.sessions where user_id = ${user.sub} and id <> ${user.sessionId} returning id`;
      for (const g of gone) forgetSession(g.id);
      return c.json({ signedOut: gone.length }, 200);
    },
  );
}
