import type { Sql } from "postgres";
import { relayOutbox, type BatchRelayer } from "./sweeper.js";

/** SQS SendMessageBatch sender (≤10/call) with tight timeouts so one hung send can't
 * eat the Lambda budget. AWS SDK is provided by the Lambda runtime (externalized
 * in the bundle). */
export async function buildSqsSender(queueUrl: string): Promise<BatchRelayer> {
  const { SQSClient, SendMessageBatchCommand } = await import("@aws-sdk/client-sqs");
  const sqs = new SQSClient({
    maxAttempts: 2,
    requestHandler: { requestTimeout: 3000, connectionTimeout: 1000 },
  });
  return async (msgs) => {
    try {
      const res = await sqs.send(
        new SendMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: msgs.map((m) => ({
            Id: String(m.id),
            MessageBody: JSON.stringify({ topic: m.topic, ...(m.payload as object) }),
          })),
        }),
      );
      const okIds = (res.Successful ?? []).map((s) => Number(s.Id));
      const failed = (res.Failed ?? []).map((f) => ({
        id: Number(f.Id),
        error: `${f.Code ?? "Unknown"}: ${f.Message ?? ""}`,
      }));
      return { okIds, failed };
    } catch (e) {
      // Whole-batch failure (network/timeout): every row is a failure → attempts bump.
      return { okIds: [], failed: msgs.map((m) => ({ id: m.id, error: String(e).slice(0, 200) })) };
    }
  };
}

/**
 * Relay the outbox right after a write commits, so a push (or an escrow command) goes
 * out in seconds instead of on the sweeper's next minute. Best-effort: the sweeper
 * still relays anything this misses, and the relay is safe to run concurrently with
 * it (FOR UPDATE SKIP LOCKED). Never throws. No queue URL (local dev) → no-op.
 */
let sender: Promise<BatchRelayer> | null = null;
export async function kickOutbox(db: Sql): Promise<void> {
  const url = process.env.OUTBOX_QUEUE_URL;
  if (!url) return;
  try {
    sender ??= buildSqsSender(url);
    await relayOutbox(db, await sender, { maxChunks: 2 });
  } catch (e) {
    console.error("[outbox-kick]", (e as Error).message);
  }
}
