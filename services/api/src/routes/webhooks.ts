import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { transition } from "../deals/commands.js";
import { getEscrowProvider } from "../money/provider.js";

/**
 * Escrow partner webhooks. A raw, signature-verified endpoint (NOT in the OpenAPI
 * client contract) — the same path the real partner will POST to; the Mock provider
 * drives it via the consumer Lambda today. Verified events become SYSTEM transitions
 * keyed by the provider event id, so a redelivered webhook is an idempotent replay.
 */
export function registerWebhooks(app: OpenAPIHono<AuthEnv>) {
  app.post("/webhooks/escrow", async (c) => {
    const raw = await c.req.text();
    const provider = await getEscrowProvider();
    if (!provider) return c.json({ error: "escrow_unconfigured" }, 503);
    if (!provider.verifyWebhookSignature(raw, c.req.header("x-escrow-signature")))
      return c.json({ error: "bad_signature" }, 401);

    const wh = provider.parseWebhook(raw);
    const db = await getDb();
    if (!db) return c.json({ error: "db_unavailable" }, 503);

    if (wh.type === "hold.confirmed") {
      const r = await transition(db, {
        dealId: wh.dealId,
        actor: "SYSTEM",
        action: "payment_confirmed",
        idempotencyKey: wh.eventId,
      });
      // A keyed webhook that can't apply (deal not PAYMENT_PENDING) is a
      // reconciliation concern, not a normal replay — surface it.
      if (!r.ok && r.code !== "idempotency_reuse")
        console.warn(`[webhook] hold.confirmed ${wh.dealId} → ${r.code}`);
    }
    // refund.settled / release.settled / hold.failed: settlement acks. In M4 the
    // refund ledger is already written at the oversold moment; release lands in M5.
    // Ack so the partner (and our consumer) stop retrying.

    return c.json({ ok: true }, 200);
  });
}
