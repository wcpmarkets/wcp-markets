import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EscrowWebhook } from "@wcp/escrow";
import type { AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { transition, type Sql } from "../deals/commands.js";
import { settleRefund } from "../money/ledger.js";
import { getEscrowProvider } from "../money/provider.js";

/**
 * Escrow partner webhooks. A raw, signature-verified endpoint (NOT in the OpenAPI
 * client contract) — the same path the real partner will POST to; the Mock provider
 * drives it via the consumer Lambda today. Verified events become SYSTEM transitions
 * keyed by the provider event id, so a redelivered webhook is an idempotent replay.
 * Anything that can't be applied is landed in reconciliation_exceptions (never
 * dropped), then acked so the partner stops retrying.
 */
async function recordException(db: Sql, wh: EscrowWebhook, detail: string) {
  await db`
    insert into public.reconciliation_exceptions (deal_id, kind, detail, payload)
    values (${wh.dealId}, ${wh.type}, ${detail}, ${db.json({ ...wh })})
  `;
  console.warn(`[webhook] ${wh.type} ${wh.dealId} → ${detail} (recorded)`);
}

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
        providerRef: wh.providerRef,
        confirmedAmountKobo: wh.amountKobo,
      });
      if (!r.ok && r.code !== "idempotency_reuse") await recordException(db, wh, `payment_confirmed:${r.code}`);
    } else if (wh.type === "hold.failed") {
      // A failed capture returns the deal to ACCEPTED (the buyer can retry). Without
      // this the deal would be stranded in PAYMENT_PENDING (no timer there by design).
      const r = await transition(db, {
        dealId: wh.dealId,
        actor: "SYSTEM",
        action: "payment_failed",
        idempotencyKey: wh.eventId,
      });
      if (!r.ok && r.code !== "idempotency_reuse") await recordException(db, wh, `payment_failed:${r.code}`);
    } else if (wh.type === "refund.settled") {
      // The refund ledger is written HERE (settlement), not at oversold time.
      await settleRefund(db, { dealId: wh.dealId, amountKobo: wh.amountKobo, providerRef: wh.providerRef });
    }
    // release.settled → M5.

    return c.json({ ok: true }, 200);
  });
}
