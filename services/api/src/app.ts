import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "./middleware/auth.js";

/**
 * The WCP API — one Hono app serving the whole contract'd REST surface, defined
 * with `@hono/zod-openapi` so the same Zod schemas validate requests AND emit the
 * OpenAPI document (see scripts/emit-openapi.ts). Runs locally via server.ts and
 * (later) as an AWS Lambda.
 *
 * Phase-2 M0 scaffold: `/health` (public) + `/me` (auth). Grows one milestone at
 * a time.
 */
export function createApp() {
  const app = new OpenAPIHono<AuthEnv>();

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

  const MeSchema = z
    .object({ userId: z.string(), phone: z.string().nullable() })
    .openapi("Me");

  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      summary: "The authenticated user",
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
    (c) => {
      const user = c.get("user");
      return c.json({ userId: user.sub, phone: user.phone });
    },
  );

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
