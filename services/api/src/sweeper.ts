import { getDb } from "./db.js";
import { fireDueDeadlines, relayOutbox, type Relayer } from "./deals/sweeper.js";

/**
 * The sweeper Lambda — invoked every 60s by EventBridge. Fires due deal deadlines
 * (auto-expiry, auto-release, auto-refund) and relays the transactional outbox to
 * SQS. Both jobs are idempotent and cheap; a scale-to-zero cron, well within free
 * tier (~44k tiny invocations/mo).
 *
 * The outbox → SQS relay uses a STANDARD queue: messages are a "poke" carrying
 * (dealId, seq); the consumer (M4) reads current state from the DB rather than
 * trusting message order, so standard-queue reordering is a non-issue.
 */
export const handler = async () => {
  const db = await getDb();
  if (!db) {
    console.warn("[sweeper] no DATABASE_URL — skipping");
    return { ok: false as const, reason: "no_db" };
  }

  const timers = await fireDueDeadlines(db);

  let relay: { relayed: number; failed: number } = { relayed: 0, failed: 0 };
  const queueUrl = process.env.OUTBOX_QUEUE_URL;
  if (queueUrl) {
    const { SQSClient, SendMessageCommand } = await import("@aws-sdk/client-sqs");
    const sqs = new SQSClient({});
    const send: Relayer = async (msg) => {
      await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({ topic: msg.topic, ...(msg.payload as object) }),
        }),
      );
    };
    relay = await relayOutbox(db, send);
  }

  console.log(
    `[sweeper] deadlines due=${timers.due} fired=${timers.fired} skipped=${timers.skipped}; ` +
      `outbox relayed=${relay.relayed} failed=${relay.failed}`,
  );
  return { ok: true as const, timers, relay };
};
