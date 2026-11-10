import type { OpenAPIHono } from "@hono/zod-openapi";
import type { EscrowWebhook } from "@wcp/escrow";
import type { AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { transition, type Sql } from "../deals/commands.js";
import { settlePayout, settleRefund, settleRelease, settleStageRelease, settleStageReturn } from "../money/ledger.js";
import { getEscrowProvider } from "../money/provider.js";
import { verifyPaystackSignature } from "../money/paystack.js";
import { handlePaystackEvent } from "../money/paystack-ops.js";

const RETURN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Payment received</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f5f1;color:#1d1d1b;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;text-align:center}
@media (prefers-color-scheme:dark){body{background:#151513;color:#eeece6}}</style></head>
<body><main><h1 style="font-size:1.25rem">Thanks — we're confirming your payment</h1>
<p>You can go back to the WCP Markets app. Your deal updates as soon as Paystack confirms.</p></main></body></html>`;

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
      // A part = one stage going back while the deal lives on (a shortlet deposit).
      const r = wh.part
        ? await settleStageReturn(db, { dealId: wh.dealId, part: wh.part, providerRef: wh.providerRef, amountKobo: wh.amountKobo })
        : await settleRefund(db, { dealId: wh.dealId, amountKobo: wh.amountKobo, providerRef: wh.providerRef });
      if (!r.ok) await recordException(db, wh, `refund.settled:${r.reason}`);
    } else if (wh.type === "release.settled") {
      // The release ledger is written HERE (settlement), not at confirm time.
      // A staged job settles stage by stage (part = stage idx).
      const r = wh.part
        ? await settleStageRelease(db, { dealId: wh.dealId, part: wh.part, providerRef: wh.providerRef, amountKobo: wh.amountKobo })
        : await settleRelease(db, { dealId: wh.dealId, providerRef: wh.providerRef, amountKobo: wh.amountKobo });
      if (!r.ok) await recordException(db, wh, `release.settled:${r.reason}`);
    } else if (wh.type === "payout.settled") {
      // seller_payable → external (money out to the seller's bank).
      const r = await settlePayout(db, { dealId: wh.dealId, amountKobo: wh.amountKobo, providerRef: wh.providerRef, part: wh.part });
      if (!r.ok) await recordException(db, wh, `payout.settled:${r.reason}`);
    }

    return c.json({ ok: true }, 200);
  });

  // ── Paystack (Phase 3 H) — signed by Paystack with our secret key ────────────
  app.post("/webhooks/paystack", async (c) => {
    const raw = await c.req.text();
    if (!(await verifyPaystackSignature(raw, c.req.header("x-paystack-signature"))))
      return c.json({ error: "bad_signature" }, 401);
    let ev: { event: string; data: Record<string, unknown> };
    try {
      ev = JSON.parse(raw);
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    if (!ev?.event || typeof ev.data !== "object" || !ev.data) return c.json({ ok: true }, 200);
    const db = await getDb();
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    try {
      await handlePaystackEvent(db, ev);
    } catch (e) {
      // A transient failure (DB): 500 makes Paystack retry. Handlers are idempotent.
      console.error(`[webhook] paystack ${ev.event} failed:`, e);
      return c.json({ error: "retry" }, 500);
    }
    return c.json({ ok: true }, 200);
  });

  // Where Paystack sends the buyer's browser after checkout. The app's WebView closes
  // on this URL; a browser shows a short note. Confirmation is the webhook, not this.
  app.get("/payments/paystack/return", (c) => c.html(RETURN_PAGE));
}
