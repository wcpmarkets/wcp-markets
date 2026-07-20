import type { Sql } from "./commands.js";
import { transition } from "./commands.js";
import type { DealAction } from "./machine.js";

/**
 * The sweeper's core, split out so it's testable without AWS. Two jobs, both
 * idempotent and safe to run every minute (and safe under two concurrent sweepers):
 *   1. fire due deal_deadlines as SYSTEM transitions (fenced by state_token)
 *   2. relay unrelayed outbox rows to a sink (SQS in prod), at-least-once
 * The Lambda entry (src/sweeper.ts) wires these to getDb() + a real SQS sender and
 * runs them independently so one failing job can't silently skip the other.
 */

/** Poison guard: a deadline/outbox row that keeps failing is skipped after this many
 * attempts so it can't wedge the head of the queue. This IS the producer-side DLQ —
 * surface `relayed_at is null and attempts >= OUTBOX_MAX_ATTEMPTS` on a metric. */
export const OUTBOX_MAX_ATTEMPTS = 10;

export type FireResult = { due: number; fired: number; skipped: number; errored: number };

/**
 * Fire every deadline whose due_at has passed. Each fires a SYSTEM transition
 * carrying the state_token the deadline was scheduled with — a deal a user already
 * moved has a rotated token, so transition() returns "stale" and the timer no-ops
 * (the "user acts at 3h59m as the 4h timer fires" race). A successful transition's
 * own syncDeadline clears/reschedules the row.
 *
 * A stuck row (stale, or — after a deploy that changes the map with old rows live —
 * illegal/not_found) is dropped token-guarded so it can't accumulate at the front of
 * the `order by due_at` scan and starve fresh timers. Each transition is isolated in
 * try/catch so one thrown DB error can't abort the whole sweep (or skip the relay).
 */
export async function fireDueDeadlines(db: Sql): Promise<FireResult> {
  const due = await db<{ deal_id: string; action: string; state_token: string }[]>`
    select deal_id, action, state_token
    from public.deal_deadlines
    where due_at <= now()
    order by due_at
    limit 200
  `;
  let fired = 0;
  let skipped = 0;
  let errored = 0;
  for (const d of due) {
    try {
      const r = await transition(db, {
        dealId: d.deal_id,
        actor: "SYSTEM",
        action: d.action as DealAction,
        expectedStateToken: d.state_token,
        reason: "deadline",
      });
      if (r.ok) {
        fired++;
      } else {
        skipped++;
        // Drop a row that will never fire from THIS token (stale/illegal/not_found).
        // Guarded by state_token so we never delete a fresh future deadline a user's
        // action installed (that row carries a different token).
        if (r.code === "stale" || r.code === "illegal" || r.code === "not_found") {
          await db`
            delete from public.deal_deadlines
            where deal_id = ${d.deal_id} and state_token = ${d.state_token}
          `;
        }
      }
    } catch (e) {
      errored++;
      console.error(`[sweeper] deadline ${d.deal_id} threw:`, e);
    }
  }
  return { due: due.length, fired, skipped, errored };
}

export type OutboxMessage = { id: number; topic: string; payload: unknown };
/** Send a batch (≤ chunk size) to the sink; report which ids succeeded/failed. */
export type BatchRelayer = (
  msgs: OutboxMessage[],
) => Promise<{ okIds: number[]; failed: { id: number; error: string }[] }>;

/**
 * Relay unrelayed outbox rows via `send` in chunks, marking each relayed in the SAME
 * tx it was locked in (FOR UPDATE SKIP LOCKED → concurrent sweepers don't
 * double-send). A send failure bumps attempts/last_error so a poison row is visible
 * (and skipped once attempts hit OUTBOX_MAX_ATTEMPTS), never retried in silence.
 *
 * Per-chunk tx (small blast radius on a timeout-kill: a re-send hits ≤ chunkSize
 * rows, not the whole batch) with a KEYSET cursor on id so a failing row — which
 * stays unrelayed — is never re-selected within the same invocation (that would
 * loop). Bounded by maxChunks per invocation; the next minute's run continues.
 *
 * At-least-once: a crash between send and commit re-sends. **M4 consumer contract:**
 * a message is a POKE carrying (dealId, seq) — read current state from the DB, do
 * NOT trust order. Side effects (payout/refund) MUST be idempotent at the sink: a
 * unique payout-intent row per deal + a dealId-derived provider reference, inserted
 * before the partner call. Standard-queue reordering/duplication is then harmless.
 */
export async function relayOutbox(
  db: Sql,
  send: BatchRelayer,
  opts: { chunkSize?: number; maxChunks?: number } = {},
): Promise<{ relayed: number; failed: number }> {
  const chunkSize = opts.chunkSize ?? 10;
  const maxChunks = opts.maxChunks ?? 20;
  let relayed = 0;
  let failed = 0;
  let cursor = 0;

  for (let chunk = 0; chunk < maxChunks; chunk++) {
    const more = await db.begin(async (sql) => {
      const rows = await sql<OutboxMessage[]>`
        select id, topic, payload from public.outbox
        where relayed_at is null and attempts < ${OUTBOX_MAX_ATTEMPTS} and id > ${cursor}
        order by id
        for update skip locked
        limit ${chunkSize}
      `;
      if (rows.length === 0) return false;
      cursor = Number(rows[rows.length - 1]!.id); // advance past failures too → progress

      const res = await send(rows);
      if (res.okIds.length) {
        await sql`update public.outbox set relayed_at = now() where id in ${sql(res.okIds)}`;
        relayed += res.okIds.length;
      }
      for (const f of res.failed) {
        failed++;
        await sql`
          update public.outbox
          set attempts = attempts + 1, last_error = ${f.error.slice(0, 500)}
          where id = ${f.id}
        `;
      }
      return true;
    });
    if (!more) break;
  }
  return { relayed, failed };
}
