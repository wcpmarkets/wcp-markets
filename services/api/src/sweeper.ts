import { getDb } from "./db.js";
import {
  fireDueDeadlines,
  relayOutbox,
  type FireResult,
} from "./deals/sweeper.js";
import { buildSqsSender } from "./deals/sqs-relay.js";
import { reconcileAndRecord } from "./money/reconcile.js";
import { completeDueRecoveries } from "./recovery/service.js";
import { expireStaleCheckouts } from "./money/checkout.js";
import { paystackConfigured } from "./money/paystack.js";

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

  // Account recoveries whose 24h hold has run out → transfer (one tx each).
  let recov = { completed: 0, failed: 0 };
  try {
    recov = await completeDueRecoveries(db);
  } catch (e) {
    errors.push(e);
    console.error("[sweeper] completeDueRecoveries failed:", e);
  }

  // Paystack checkouts left open past their TTL → verify, then confirm or give up.
  let checkouts = { confirmed: 0, abandoned: 0 };
  try {
    if (await paystackConfigured()) checkouts = await expireStaleCheckouts(db);
  } catch (e) {
    errors.push(e);
    console.error("[sweeper] expireStaleCheckouts failed:", e);
  }

  // AI search cache (3I): readings are only served for 7 days; keep a little past that.
  try {
    await db`delete from public.search_interpretations where created_at < now() - interval '14 days'`;
  } catch (e) {
    // Before migration 0031 the table doesn't exist; not worth failing the run over.
    console.warn("[sweeper] search cache prune skipped:", e instanceof Error ? e.message : e);
  }

  console.log(
    `[sweeper] checkouts confirmed=${checkouts.confirmed} abandoned=${checkouts.abandoned}; recoveries completed=${recov.completed} failed=${recov.failed}; deadlines due=${timers?.due ?? "?"} fired=${timers?.fired ?? "?"} ` +
      `skipped=${timers?.skipped ?? "?"} errored=${timers?.errored ?? "?"}; ` +
      `outbox relayed=${relay.relayed} failed=${relay.failed}; reconcile ${recon}`,
  );

  if (errors.length) throw new AggregateError(errors, "[sweeper] one or more jobs failed");
  return { ok: true as const, timers, relay };
};
