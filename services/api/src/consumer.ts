import { MockEscrowProvider } from "@wcp/escrow";
import { fetchSsm } from "./secrets.js";

/**
 * The escrow orchestrator — an SQS consumer on the deal-events queue (fed by the
 * sweeper relaying the transactional outbox). It turns escrow COMMANDS (create_hold,
 * refund) into provider calls, then POSTs the provider's signed webhook back to the
 * API's /webhooks/escrow — exercising the exact async hold→confirm path the real
 * partner will drive. Non-escrow messages (deal.transition, …) are acked untouched.
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
      };
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
          idempotencyKey: `refund:${msg.dealId}`,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "refund.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.amount!,
        }));
      } else if (msg.topic === "escrow.release") {
        const txn = await provider.releaseToSeller({
          dealId: msg.dealId,
          amountKobo: msg.payout!,
          idempotencyKey: `release:${msg.dealId}`,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "release.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.payout!,
        }));
      } else if (msg.topic === "escrow.payout") {
        const txn = await provider.payoutToSeller({
          dealId: msg.dealId,
          amountKobo: msg.amount!,
          idempotencyKey: `payout:${msg.dealId}`,
        });
        await postWebhook(apiUrl, provider.buildWebhook({
          eventId: `${txn.providerRef}:settled`,
          type: "payout.settled",
          providerRef: txn.providerRef,
          dealId: msg.dealId,
          amountKobo: msg.amount!,
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

async function postWebhook(apiUrl: string, wh: { body: string; signature: string }) {
  const res = await fetch(`${apiUrl}/webhooks/escrow`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-escrow-signature": wh.signature },
    body: wh.body,
  });
  if (!res.ok) throw new Error(`webhook POST ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
