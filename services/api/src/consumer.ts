import { MockEscrowProvider } from "@wcp/escrow";
import { fetchSsm } from "./secrets.js";
import { getDb } from "./db.js";
import { dealRail, refundLatePayment, requestRefund, requestTransfer } from "./money/paystack-ops.js";
import { handleNotifyEvent, NOTIFY_TOPICS } from "./notify/push.js";
import { handleListingPriced, WATCH_TOPICS } from "./notify/watch.js";

/**
 * The escrow orchestrator — an SQS consumer on the deal-events queue (fed by the
 * sweeper relaying the transactional outbox). It turns escrow COMMANDS (create_hold,
 * refund) into provider calls, then POSTs the provider's signed webhook back to the
 * API's /webhooks/escrow — exercising the exact async hold→confirm path the real
 * partner will drive. deal.created / deal.transition / message.created become push
 * notifications (notify/push.ts); anything else is acked untouched.
 *
 * Partial-batch failures: a failed record is reported so ONLY it is retried (the rest
 * are deleted). Provider calls are idempotent on a dealId-derived key, and the
 * downstream transition is idempotent on the provider event id, so at-least-once
 * redelivery is safe.
 */
type SqsRecord = { messageId: string; body: string };
type SqsEvent = { Records: SqsRecord[] };

export const handler = async (event: SqsEvent) => {
  const secret =
    process.env.ESCROW_WEBHOOK_SECRET ??
    (await fetchSsm(process.env.ESCROW_WEBHOOK_SECRET_SSM ?? "/wcp/api/escrow-webhook-secret"));
  const apiUrl = process.env.API_URL;
  if (!secret || !apiUrl) throw new Error("[consumer] missing ESCROW secret or API_URL");
  const provider = new MockEscrowProvider(secret);

  const batchItemFailures: { itemIdentifier: string }[] = [];
  for (const rec of event.Records) {
    try {
      const msg = JSON.parse(rec.body) as {
        topic: string;
        dealId: string;
        amount?: number;
        payout?: number;
        part?: number; // a staged job's stage / a deal's nth payout
        sellerId?: string;
        reference?: string;
      };
      if (WATCH_TOPICS.has(msg.topic)) {
        await handleListingPriced(await needDb(), msg as Parameters<typeof handleListingPriced>[1]);
        continue;
      }
      if (NOTIFY_TOPICS.has(msg.topic)) {
        await handleNotifyEvent(await needDb(), msg as Parameters<typeof handleNotifyEvent>[1]);
        continue;
      }
      const part = msg.part || undefined;
      const suffix = part ? `:${part}` : "";
      // Paystack deals (3H): refunds and payouts are real Paystack calls, settled by
      // Paystack's own webhooks. Releases stay internal (the money never leaves WCP's
      // balance), so they take the self-webhook path below like the mock.
      if (msg.topic === "paystack.refund_late") {
        await refundLatePayment(await needDb(), { dealId: msg.dealId, reference: msg.reference!, amountKobo: msg.amount! });
        continue;
      }
      if (msg.topic === "escrow.refund" || msg.topic === "escrow.payout") {
        const db = await needDb();
        if ((await dealRail(db, msg.dealId)) === "paystack") {
          if (msg.topic === "escrow.refund") await requestRefund(db, { dealId: msg.dealId, amountKobo: msg.amount!, part });
          else {
            const sellerId = msg.sellerId ?? (await db<{ seller_id: string }[]>`select seller_id from public.deals where id = ${msg.dealId}`)[0]!.seller_id;
            await requestTransfer(db, { dealId: msg.dealId, amountKobo: msg.amount!, sellerId, part });
          }
          continue;
        }
      }
      if (msg.topic === "escrow.create_hold") {
        const txn = await provider.createHold({
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          idempotencyKey: `hold:${msg.dealId}`,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:confirmed`,
          type: "hold.confirmed",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.amount!,
        }));
      } else if (msg.topic === "escrow.refund") {
        const txn = await provider.refundToBuyer({
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          idempotencyKey: `refund:${msg.dealId}${suffix}`,
          part,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "refund.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          part,
        }));
      } else if (msg.topic === "escrow.release") {
        const txn = await provider.releaseToSeller({
          dealId: msg.dealId,
          amountKobo: msg.payout!,
          idempotencyKey: `release:${msg.dealId}${suffix}`,
          part,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "release.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.payout!,
          part,
        }));
      } else if (msg.topic === "escrow.payout") {
        const txn = await provider.payoutToSeller({
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          idempotencyKey: `payout:${msg.dealId}${suffix}`,
          part,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "payout.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          part,
        }));
      }
      // else: not an escrow command — ack (delete) without action.
    } catch (e) {
      console.error(`[consumer] ${rec.messageId} failed:`, e);
      batchItemFailures.push({ itemIdentifier: rec.messageId });
    }
  }
  return { batchItemFailures };
};

async function needDb() {
  const db = await getDb();
  if (!db) throw new Error("[consumer] database unavailable (DATABASE_URL_SSM)");
  return db;
}

async function postWebhook(apiUrl: string, wh: { body: string; signature: string }) {
  const res = await fetch(`${apiUrl}/webhooks/escrow`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-escrow-signature": wh.signature },
    body: wh.body,
  });
  if (!res.ok) throw new Error(`webhook POST ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
