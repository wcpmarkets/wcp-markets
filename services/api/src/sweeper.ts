import { getDb } from "./db.js";
import {
  fireDueDeadlines,
  relayOutbox,
  type BatchRelayer,
  type FireResult,
} from "./deals/sweeper.js";
import { reconcileAndRecord } from "./money/reconcile.js";

/**
 * The sweeper Lambda — invoked every 60s by EventBridge. Fires due deal deadlines
 * (auto-expiry, auto-release, auto-refund) and relays the transactional outbox to
 * SQS. Both jobs are idempotent and cheap; a scale-to-zero cron, well within free
 * tier (~44k tiny invocations/mo).
 *
 * FAIL LOUD: a degraded environment (no DB, no queue URL) THROWS rather than
 * returning quietly — a silent sweeper means every escrow timer freezes with a green
 * dashboard, the single most dangerous failure mode. CloudWatch alarms on this
 * function's Errors and Invocations (see infra) turn a throw / a stopped cron into a
 * page. The two jobs run independently so one failing can't skip the other.
 *
 * The outbox → SQS relay uses a STANDARD queue: messages are a "poke" carrying
 * (dealId, seq); the M4 consumer reads current state from the DB and makes side
 * effects idempotent at the sink, so standard-queue reordering is a non-issue.
 */
export const handler = async () => {
  const db = await getDb();
  if (!db) throw new Error("[sweeper] no DATABASE_URL — cannot run (SSM/secret broken?)");

  const queueUrl = process.env.OUTBOX_QUEUE_URL;
  if (!queueUrl) throw new Error("[sweeper] OUTBOX_QUEUE_URL unset — refusing to run half the job");

  // Run both jobs; capture (don't propagate) each error so the other still runs, then
  // rethrow at the end so CloudWatch records the failure.
  let timers: FireResult | undefined;
  let relay = { relayed: 0, failed: 0 };
  const errors: unknown[] = [];

  try {
    timers = await fireDueDeadlines(db);
  } catch (e) {
    errors.push(e);
    console.error("[sweeper] fireDueDeadlines failed:", e);
  }

  try {
    relay = await relayOutbox(db, await buildSqsSender(queueUrl));
  } catch (e) {
    errors.push(e);
    console.error("[sweeper] relayOutbox failed:", e);
  }

  // Ledger reconciliation (the scheduled money-integrity check). Records drift
  // durably; never blocks the timer/relay jobs.
  let recon = "?";
  try {
    const r = await reconcileAndRecord(db);
    recon =
      `drift=${r.driftDeals.length} overdue=${r.settlementOverdue.length} parked=${r.parkedOutbox} ` +
      `disputesOverdue=${r.disputesOverdue.length} payoutsOverdue=${r.payoutsOverdue.length} negPayable=${r.negativePayable.length}` +
      (r.globalBalanceKobo !== 0 ? " +GLOBAL_IMBALANCE" : "");
  } catch (e) {
    errors.push(e);
    console.error("[sweeper] reconcile failed:", e);
  }

  console.log(
    `[sweeper] deadlines due=${timers?.due ?? "?"} fired=${timers?.fired ?? "?"} ` +
      `skipped=${timers?.skipped ?? "?"} errored=${timers?.errored ?? "?"}; ` +
      `outbox relayed=${relay.relayed} failed=${relay.failed}; reconcile ${recon}`,
  );

  if (errors.length) throw new AggregateError(errors, "[sweeper] one or more jobs failed");
  return { ok: true as const, timers, relay };
};

/** SQS SendMessageBatch sender (≤10/call) with tight timeouts so one hung send can't
 * eat the 50s Lambda budget. AWS SDK is provided by the Lambda runtime (externalized
 * in the bundle). */
async function buildSqsSender(queueUrl: string): Promise<BatchRelayer> {
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
