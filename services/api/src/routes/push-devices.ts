import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "../db.js";
import { auth, type AuthEnv } from "../middleware/auth.js";

/**
 * Push devices (FCM tokens). The app registers its token after sign-in and whenever
 * FCM rotates it, and removes it on sign-out. A token is one install: registering it
 * under another account moves it there. Each row is tied to the auth session that
 * registered it, so revoking that session drops the device (0033).
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const PushDeviceRequestSchema = z
  .object({
    token: z.string().min(20).max(4096),
    platform: z.enum(["android", "ios"]),
  })
  .openapi("PushDeviceRequest");

const PushDeviceSchema = z.object({ registered: z.boolean() }).openapi("PushDevice");

export function registerPushDevices(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "put",
      path: "/me/push-devices",
      summary: "Register this install's push token",
      tags: ["notifications"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { required: true, content: { "application/json": { schema: PushDeviceRequestSchema } } } },
      responses: {
        200: { description: "Registered", content: { "application/json": { schema: PushDeviceSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "This sign-in has ended", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { token, platform } = c.req.valid("json");
      try {
        await db`
          insert into public.push_devices (token, user_id, session_id, platform)
          values (${token}, ${user.sub}, ${user.sessionId}, ${platform})
          on conflict (token) do update
            set user_id = excluded.user_id, session_id = excluded.session_id,
                platform = excluded.platform, last_seen_at = now()`;
      } catch (e) {
        // The session was revoked between the token check and now (FK to auth.sessions).
        if ((e as { code?: string }).code === "23503") return c.json({ error: "session_ended" }, 409);
        throw e;
      }
      return c.json({ registered: true }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/push-devices/remove",
      summary: "Stop push to this install (on sign-out)",
      tags: ["notifications"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { required: true, content: { "application/json": { schema: PushDeviceRequestSchema.pick({ token: true }).openapi("PushDeviceRemove") } } } },
      responses: {
        200: { description: "Removed (or wasn't registered)", content: { "application/json": { schema: PushDeviceSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { token } = c.req.valid("json");
      await db`delete from public.push_devices where token = ${token} and user_id = ${user.sub}`;
      return c.json({ registered: false }, 200);
    },
  );
}
