import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "./middleware/auth.js";
import { clientIp } from "./middleware/rate-limit.js";
import { getDb } from "./db.js";
import { registerListings } from "./routes/listings.js";
import { registerDeals } from "./routes/deals.js";
import { registerDisputes } from "./routes/disputes.js";
import { registerWebhooks } from "./routes/webhooks.js";

/**
 * The WCP API — one Hono app serving the whole contract'd REST surface, defined
 * with `@hono/zod-openapi` so the same Zod schemas validate requests AND emit the
 * OpenAPI document (see scripts/emit-openapi.ts). Runs locally via server.ts and
 * (later) as an AWS Lambda.
 *
 * Phase-2 M0 scaffold: `/health`, `/me`, `/auth/otp/request`. Grows one milestone
 * at a time.
 */
export function createApp() {
  const app = new OpenAPIHono<AuthEnv>();

  const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

  // ── GET /health ───────────────────────────────────────────────────────────
  const HealthSchema = z
    .object({ status: z.literal("ok"), ts: z.string() })
    .openapi("Health");

  app.openapi(
    createRoute({
      method: "get",
      path: "/health",
      summary: "Liveness check",
      tags: ["system"],
      responses: {
        200: {
          description: "Service is up",
          content: { "application/json": { schema: HealthSchema } },
        },
      },
    }),
    (c) => c.json({ status: "ok" as const, ts: new Date().toISOString() }),
  );

  // ── GET /me ─────────────────────────────────────────────────────────────────
  const MeSchema = z
    .object({
      userId: z.string(),
      phone: z.string().nullable(),
      displayName: z.string().nullable(),
      verificationLevel: z.number().int(),
    })
    .openapi("Me");

  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      summary: "The authenticated user's profile",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: {
          description: "Current user",
          content: { "application/json": { schema: MeSchema } },
        },
        401: { description: "Missing or invalid token" },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) {
        return c.json({
          userId: user.sub,
          phone: user.phone,
          displayName: null,
          verificationLevel: 1,
        });
      }
      // Upsert-on-first-sign-in, then read the profile (service-role write).
      const rows = await db<
        { display_name: string | null; phone: string | null; verification_level: number }[]
      >`
        insert into public.profiles (id, phone)
        values (${user.sub}, ${user.phone})
        on conflict (id) do update
          set updated_at = now(),
              phone = coalesce(public.profiles.phone, ${user.phone})
        returning display_name, phone, verification_level
      `;
      const p = rows[0]!;
      return c.json({
        userId: user.sub,
        phone: p.phone,
        displayName: p.display_name,
        verificationLevel: p.verification_level,
      });
    },
  );

  // ── POST /auth/otp/request ──────────────────────────────────────────────────
  // Throttled OTP request. Rate-limiting lives HERE (per-phone + per-IP) so a bare
  // SMS-sending endpoint can't be pumped. Forwards to Supabase Auth when
  // configured; 501 until SUPABASE_URL/ANON_KEY are set.
  const OtpOk = z.object({ status: z.literal("sent") }).openapi("OtpRequested");

  app.openapi(
    createRoute({
      method: "post",
      path: "/auth/otp/request",
      summary: "Request a phone OTP (rate-limited)",
      tags: ["auth"],
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ phone: z.string().min(8) }).openapi("OtpRequest"),
            },
          },
        },
      },
      responses: {
        202: {
          description: "OTP dispatched",
          content: { "application/json": { schema: OtpOk } },
        },
        429: {
          description: "Rate limited",
          content: { "application/json": { schema: ErrorSchema } },
        },
        501: {
          description: "Auth not configured",
          content: { "application/json": { schema: ErrorSchema } },
        },
        502: {
          description: "Upstream OTP send failed",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { phone } = c.req.valid("json");
      const db = await getDb();
      if (db) {
        const checks: { bucket: string; limit: number }[] = [
          { bucket: `otp:phone:${phone}`, limit: 3 },
          { bucket: `otp:ip:${clientIp(c)}`, limit: 10 },
        ];
        for (const ch of checks) {
          const rows = await db<{ allowed: boolean }[]>`
            select public.consume_rate_limit(${ch.bucket}, ${ch.limit}, ${900}) as allowed
          `;
          if (!rows[0]?.allowed) return c.json({ error: "rate_limited" }, 429);
        }
      }

      const url = process.env.SUPABASE_URL;
      const anon = process.env.SUPABASE_ANON_KEY;
      if (!url || !anon) return c.json({ error: "auth_not_configured" }, 501);

      const res = await fetch(`${url}/auth/v1/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: anon },
        body: JSON.stringify({ phone, create_user: true }),
      });
      if (!res.ok) return c.json({ error: "otp_send_failed" }, 502);
      return c.json({ status: "sent" as const }, 202);
    },
  );

  // ── Listings (M1 — Goods) ────────────────────────────────────────────────
  registerListings(app);

  // ── Deals + chat (M3) ─────────────────────────────────────────────────────
  registerDeals(app);

  // ── Disputes (M6) ─────────────────────────────────────────────────────────
  registerDisputes(app);

  // ── Escrow webhooks (M4) — raw signed endpoint, not in the client contract ──
  registerWebhooks(app);

  // Security scheme for the emitted spec.
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
    bearerFormat: "JWT",
  });

  return app;
}

export type App = ReturnType<typeof createApp>;

/** OpenAPI 3.1 document — the committed contract artifact + runtime `/openapi.json`. */
export function openApiDocument(app: App): Record<string, unknown> {
  return app.getOpenAPI31Document({
    openapi: "3.1.0",
    info: {
      title: "WCP Markets API",
      version: "0.0.1",
      description: "Contract-first API for the WCP Markets platform.",
    },
  }) as unknown as Record<string, unknown>;
}
