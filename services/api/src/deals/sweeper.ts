import type { Sql } from "./commands.js";
import { transition } from "./commands.js";
import type { DealAction } from "./machine.js";

/**
 * The sweeper's core, split out so it's testable without AWS. Two jobs, both
 * idempotent and safe to run every minute:
 *   1. fire due deal_deadlines as SYSTEM transitions (fenced by state_token)
 *   2. relay unrelayed outbox rows to a sink (SQS in prod), at-least-once
 * The Lambda entry (src/sweeper.ts) wires these to getDb() + a real SQS sender.
 */

export type FireResult = { due: number; fired: number; skipped: number };

/**
 * Fire every deadline whose due_at has passed. Each fires a SYSTEM transition
 * carrying the state_token the deadline was scheduled with — a deal a user already
 * moved has a rotated token, so transition() returns "stale" and the timer no-ops
 * (the "user acts at 3h59m as the 4h timer fires" race). A successful transition's
 * own syncDeadline clears/reschedules the row; a genuinely stale row (its token no
 * longer current) is dropped so we don't reprocess it.
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
  for (const d of due) {
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
      // Stale: a user action already rotated the token (and rescheduled the row).
      // Delete only if THIS token's row is still somehow present, so we never drop
      // the fresh future deadline the user's action installed.
      if (r.code === "stale") {
        await db`
          delete from public.deal_deadlines
          where deal_id = ${d.deal_id} and state_token = ${d.state_token}
        `;
      }
    }
  }
  return { due: due.length, fired, skipped };
}

export type OutboxMessage = { id: number; topic: string; payload: unknown };
export type Relayer = (msg: OutboxMessage) => Promise<void>;

/**
 * Relay unrelayed outbox rows via `send`, marking each relayed in the SAME tx it was
 * locked in (FOR UPDATE SKIP LOCKED → concurrent sweepers don't double-send). A send
 * failure bumps attempts/last_error so a poison row is visible, not retried forever
 * in silence. At-least-once: a crash between send and commit re-sends — consumers
 * dedupe on (deal_id, event_seq) in the payload.
 *
 * One bounded batch per invocation (no re-select loop — a failing row stays
 * unrelayed and would otherwise be picked again immediately). Any remainder beyond
 * `limit` is caught by the next minute's run.
 */
export async function relayOutbox(db: Sql, send: Relayer, limit = 100): Promise<{ relayed: number; failed: number }> {
  return db.begin(async (sql) => {
    const rows = await sql<OutboxMessage[]>`
      select id, topic, payload from public.outbox
      where relayed_at is null
      order by id
      for update skip locked
      limit ${limit}
    `;
    let relayed = 0;
    let failed = 0;
    for (const row of rows) {
      try {
        await send(row);
        await sql`update public.outbox set relayed_at = now() where id = ${row.id}`;
        relayed++;
      } catch (e) {
        failed++;
        await sql`
          update public.outbox
          set attempts = attempts + 1, last_error = ${String(e).slice(0, 500)}
          where id = ${row.id}
        `;
      }
    }
    return { relayed, failed };
  });
}
