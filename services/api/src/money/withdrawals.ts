import { randomUUID } from "node:crypto";
import type { Sql, Tx } from "../deals/commands.js";
import { MIN_WITHDRAWAL_KOBO, transferFeeKobo } from "./fees.js";
import { hasPepper } from "../kyc/idhash.js";
import { payoutsPausedByRecovery } from "../recovery/service.js";
import { initiateTransfer, PaystackError, verifyTransfer } from "./paystack.js";

/**
 * Pooled withdrawals (migration 0043). A withdrawal is ONE bank transfer, so ONE
 * transfer fee, covering one or more whole sales; its payouts rows are the lines that
 * say which sales and how much. The ledger stays per deal: when the transfer settles,
 * each line books its own seller_payable → external pair, all in one balanced group.
 *
 * v1 rules (product decisions 2026-11-26, after review):
 *  - a withdrawal takes WHOLE sales — everything available, or the sales picked —
 *    never part of a sale;
 *  - the seller pays the transfer fee: the bank receives amount − fee;
 *  - ₦1,000 minimum, unless the withdrawal empties the balance and exceeds its fee;
 *  - one withdrawal in flight per seller per rail (a DB index), created under a
 *    per-seller lock, and never over a deal's balance (DB triggers).
 *
 * Money is checked in SQL, not only here: lines sum to the withdrawal, a line never
 * exceeds what its deal still owes, and no deal's seller_payable can go negative.
 */

export type Rail = "mock" | "paystack";
type Db = Sql | Tx;

/** A sale whose released money can be withdrawn now. */
export type ReadyDeal = { dealId: string; title: string; amountKobo: number; releasedAt: Date; rail: Rail };

/** The states a sale's released money can be withdrawn in: a finished deal, or a staged
 * job between stages (paid as work is done) — never while disputed. */
const STAGED_PAYABLE = ["PAID_IN_ESCROW", "HANDED_OFF", "CANCELLED"];

/** Every sale with released money and nothing already in flight, oldest release first. */
export async function readyDeals(db: Db, sellerId: string): Promise<ReadyDeal[]> {
  const rows = await db<{
    deal_id: string; title: string | null; payable: string; pending: string; released_at: Date | null;
    state: string; staged: boolean; payment_provider: string | null;
  }[]>`
    with mine as (
      select d.id, d.state, d.listing_id, d.payment_provider,
             exists (select 1 from public.deal_milestones m where m.deal_id = d.id) as staged
      from public.deals d where d.seller_id = ${sellerId}
    ),
    led as (
      select le.deal_id, sum(le.amount_kobo) as payable,
             max(le.created_at) filter (where le.movement = 'release') as released_at
      from public.ledger_entries le join mine on mine.id = le.deal_id
      where le.account = 'seller_payable'
      group by le.deal_id
    ),
    inflight as (
      select deal_id, sum(amount_kobo) as s from public.payouts
      where seller_id = ${sellerId} and status = 'pending' group by deal_id
    )
    select mine.id as deal_id, l.title, led.payable::bigint as payable,
           coalesce(inflight.s, 0)::bigint as pending, led.released_at,
           mine.state, mine.staged, mine.payment_provider
    from mine
    join led on led.deal_id = mine.id
    left join inflight on inflight.deal_id = mine.id
    left join public.listings l on l.id = mine.listing_id
    where led.payable > 0
  `;
  return rows
    .filter((r) => Number(r.pending) === 0 && (r.state === "COMPLETED" || (r.staged && STAGED_PAYABLE.includes(r.state))))
    .map((r) => ({
      dealId: r.deal_id,
      title: r.title ?? "Listing removed",
      amountKobo: Number(r.payable),
      releasedAt: r.released_at ?? new Date(0),
      rail: (r.payment_provider === "paystack" ? "paystack" : "mock") as Rail,
    }))
    .sort((a, b) => a.releasedAt.getTime() - b.releasedAt.getTime() || a.dealId.localeCompare(b.dealId));
}

export type Quote = {
  grossKobo: number;
  feeKobo: number;
  netKobo: number;
  allowed: boolean;
  /** Why not: nothing to withdraw, or under the minimum without emptying the balance. */
  reason: "nothing_to_withdraw" | "below_minimum" | null;
};

/**
 * What withdrawing `chosen` would cost and send. One transfer per rail, so a (test-only)
 * mix of mock and Paystack sales is two transfers and two fees. `balanceKobo` is
 * everything withdrawable now: taking all of it waives the minimum.
 */
export function quote(chosen: ReadyDeal[], balanceKobo: number): Quote & { byRail: Map<Rail, ReadyDeal[]> } {
  const byRail = new Map<Rail, ReadyDeal[]>();
  for (const d of chosen) byRail.set(d.rail, [...(byRail.get(d.rail) ?? []), d]);
  let gross = 0, fee = 0, allowed = chosen.length > 0;
  const emptiesBalance = chosen.reduce((a, d) => a + d.amountKobo, 0) === balanceKobo;
  for (const deals of byRail.values()) {
    const g = deals.reduce((a, d) => a + d.amountKobo, 0);
    const f = transferFeeKobo(g);
    gross += g; fee += f;
    if (!(g > f && (g >= MIN_WITHDRAWAL_KOBO || emptiesBalance))) allowed = false;
  }
  return {
    grossKobo: gross, feeKobo: fee, netKobo: gross - fee, allowed, byRail,
    reason: chosen.length === 0 ? "nothing_to_withdraw" : allowed ? null : "below_minimum",
  };
}

export type WithdrawalRow = {
  id: string; seller_id: string; amount_kobo: string; fee_kobo: string; net_kobo: string; status: string; rail: Rail;
  bank_name: string | null; account_last4: string | null; created_at: Date; settled_at: Date | null;
};
const W_COLS = "id, seller_id, amount_kobo, fee_kobo, net_kobo, status, rail, bank_name, account_last4, created_at, settled_at";

export type CreateResult =
  | { ok: true; withdrawals: WithdrawalRow[]; replay: boolean }
  | { ok: false; status: 403 | 409; error: string };

/**
 * Make the withdrawal(s) for `dealIds` (all of them if omitted). Gates first (ID check,
 * account recovery, a real payout account for real money), then, under a per-seller
 * advisory lock, recompute what's available, quote, and write the withdrawal, its lines
 * and the command to send it — or replay the withdrawal a repeated key already made.
 */
export async function createWithdrawals(
  db: Sql,
  p: { sellerId: string; dealIds?: string[]; idempotencyKey: string },
): Promise<CreateResult> {
  const [prof] = await db<{ verification_level: number }[]>`select verification_level from public.profiles where id = ${p.sellerId}`;
  if ((prof?.verification_level ?? 1) < 2) return { ok: false, status: 403, error: "kyc_required" };
  // Verified before ID hashes were kept: one re-verify, so a lost number can be
  // recovered by ID rather than by an admin. Only once a pepper exists to hash with.
  const [kh] = await db<{ id_hash: string | null }[]>`select id_hash from public.kyc_verifications where user_id = ${p.sellerId}`;
  if (!kh?.id_hash && (await hasPepper())) return { ok: false, status: 403, error: "kyc_reverify" };
  // An account mid-recovery: whoever ends up holding it gets the money, not now.
  if (await payoutsPausedByRecovery(db, p.sellerId)) return { ok: false, status: 409, error: "recovery_hold" };

  try {
    return await db.begin(async (sql) => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${"withdraw:" + p.sellerId}, 0))`;
      const prior = await sql<WithdrawalRow[]>`
        select ${sql.unsafe(W_COLS)} from public.withdrawals
        where seller_id = ${p.sellerId} and idempotency_key = ${p.idempotencyKey} order by created_at`;
      if (prior.length) return { ok: true as const, withdrawals: prior, replay: true };

      const ready = await readyDeals(sql, p.sellerId);
      const balance = ready.reduce((a, d) => a + d.amountKobo, 0);
      let chosen = ready;
      if (p.dealIds) {
        const want = new Set(p.dealIds);
        chosen = ready.filter((d) => want.has(d.dealId));
        if (chosen.length !== want.size) {
          // Asked for a sale that isn't withdrawable — maybe because it's already on its way.
          const [inflight] = await sql`
            select 1 from public.payouts where seller_id = ${p.sellerId} and status = 'pending' and deal_id = any(${[...want]}::uuid[]) limit 1`;
          return { ok: false as const, status: 409 as const, error: inflight ? "already_requested" : "not_payable" };
        }
      }
      const q = quote(chosen, balance);
      if (!q.allowed) {
        if (!chosen.length) {
          const [inflight] = await sql`select 1 from public.withdrawals where seller_id = ${p.sellerId} and status = 'pending' limit 1`;
          return { ok: false as const, status: 409 as const, error: inflight ? "withdrawal_pending" : "nothing_to_withdraw" };
        }
        return { ok: false as const, status: 409 as const, error: q.reason ?? "below_minimum" };
      }

      const [acct] = await sql<{ recipient_code: string; provider: string; bank_name: string; account_last4: string }[]>`
        select recipient_code, provider, bank_name, account_last4 from public.payout_accounts where user_id = ${p.sellerId}`;
      if (q.byRail.has("paystack") && acct?.provider !== "paystack")
        return { ok: false as const, status: 409 as const, error: "no_payout_account" };

      const made: WithdrawalRow[] = [];
      for (const [rail, deals] of q.byRail) {
        const gross = deals.reduce((a, d) => a + d.amountKobo, 0);
        // Real money goes to the account as it is now, snapshotted; the mock rail
        // records whatever account exists (none is fine).
        const dest = rail === "paystack" || acct?.provider === rail ? acct : undefined;
        const [w] = await sql<WithdrawalRow[]>`
          insert into public.withdrawals
            (seller_id, amount_kobo, fee_kobo, rail, recipient_code, bank_name, account_last4, idempotency_key)
          values (${p.sellerId}, ${gross}, ${transferFeeKobo(gross)}, ${rail},
                  ${dest?.recipient_code ?? null}, ${dest?.bank_name ?? null}, ${dest?.account_last4 ?? null}, ${p.idempotencyKey})
          returning ${sql.unsafe(W_COLS)}`;
        for (const d of deals) {
          // `part` numbers a deal's payouts 0, 1, … (a staged job is withdrawn as stages release).
          await sql`
            insert into public.payouts (deal_id, seller_id, amount_kobo, part, withdrawal_id)
            values (${d.dealId}, ${p.sellerId}, ${d.amountKobo},
                    (select coalesce(max(part) + 1, 0) from public.payouts where deal_id = ${d.dealId}), ${w!.id})`;
        }
        await sql`
          insert into public.outbox (topic, payload)
          values ('escrow.withdrawal', ${sql.json({ withdrawalId: w!.id, rail })})`;
        made.push(w!);
      }
      return { ok: true as const, withdrawals: made, replay: false };
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    // Another withdrawal on this rail is in flight (or a concurrent twin won the race).
    if (code === "23505") return { ok: false, status: 409, error: "withdrawal_pending" };
    // A balance trigger refused a line: the balance moved under us. Ask again.
    if (code === "23514") return { ok: false, status: 409, error: "balance_changed" };
    throw e;
  }
}

/** Record something ops must look at; the sweeper's alarm watches this table. */
async function exception(db: Db, kind: string, detail: string, payload: Record<string, unknown>) {
  await db`
    insert into public.reconciliation_exceptions (deal_id, kind, detail, payload)
    values (null, ${kind}, ${detail}, ${db.json(payload as never)})`;
  console.warn(`[withdrawal] ${kind} → ${detail} (recorded)`);
}

export type SettleResult = { ok: true; late?: boolean } | { ok: false; reason: string };

/**
 * The transfer landed: book every line to the ledger (one group, keyed by the
 * withdrawal) and mark it all settled. `sentKobo` is what the provider says it sent,
 * which is the NET (the fee came out of it). A success that arrives after we'd marked
 * it failed still books — the money did leave — and is flagged; if the seller had
 * already withdrawn those sales again, the non-negative balance trigger refuses it and
 * the caller records an overdraw for ops.
 */
export async function settleWithdrawal(
  db: Sql,
  p: { withdrawalId: string; sentKobo: number; providerRef: string; actualFeeKobo?: number | null },
): Promise<SettleResult> {
  return db.begin(async (sql) => {
    const [w] = await sql<{ id: string; status: string; net_kobo: string }[]>`
      select id, status, net_kobo from public.withdrawals where id = ${p.withdrawalId} for update`;
    if (!w) return { ok: false, reason: "unknown_withdrawal" };
    if (w.status === "settled") return { ok: true }; // redelivery
    if (w.status === "reversed") return { ok: false, reason: "already_reversed" };
    if (p.sentKobo !== Number(w.net_kobo)) return { ok: false, reason: `amount_mismatch:${p.sentKobo}!=${w.net_kobo}` };
    const lines = await sql<{ deal_id: string; amount_kobo: string }[]>`
      select deal_id, amount_kobo from public.payouts where withdrawal_id = ${w.id} for update`;
    if (!lines.length) return { ok: false, reason: "no_lines" };
    const rows = lines.flatMap((l) => [
      { txn_group: w.id, deal_id: l.deal_id, account: "seller_payable", amount_kobo: -Number(l.amount_kobo), movement: "payout", provider_ref: p.providerRef },
      { txn_group: w.id, deal_id: l.deal_id, account: "external", amount_kobo: Number(l.amount_kobo), movement: "payout", provider_ref: p.providerRef },
    ]);
    const inserted = await sql`
      insert into public.ledger_entries ${sql(rows, "txn_group", "deal_id", "account", "amount_kobo", "movement", "provider_ref")}
      on conflict do nothing returning 1`;
    // Every line must book. A silent ON CONFLICT drop would pay the bank without
    // debiting the deal — roll the whole settlement back instead.
    if (inserted.length !== rows.length) throw new Error(`[withdrawal] ${w.id}: booked ${inserted.length}/${rows.length} ledger rows`);
    await sql`
      update public.withdrawals set status = 'settled', settled_at = now(), updated_at = now(),
        provider_ref = ${p.providerRef}, actual_fee_kobo = ${p.actualFeeKobo ?? null}
      where id = ${w.id}`;
    await sql`
      update public.payouts set status = 'settled', settled_at = now(), provider_ref = ${p.providerRef}
      where withdrawal_id = ${w.id}`;
    return { ok: true, late: w.status === "failed" };
  });
}

/** The transfer didn't happen: its sales are withdrawable again (nothing was booked). */
export async function failWithdrawal(db: Db, withdrawalId: string, reason: string): Promise<boolean> {
  const [w] = await db`
    update public.withdrawals set status = 'failed', failure_reason = ${reason.slice(0, 300)}, updated_at = now()
    where id = ${withdrawalId} and status = 'pending' returning id`;
  if (!w) return false;
  await db`update public.payouts set status = 'failed' where withdrawal_id = ${withdrawalId} and status = 'pending'`;
  return true;
}

/**
 * The bank sent it back after it had landed (transfer.reversed). The ledger is
 * append-only, so each line gets a compensating payout_reversal pair: the money is the
 * seller's again and their sales become withdrawable. Before a success it's a failure.
 */
export async function reverseWithdrawal(db: Sql, p: { withdrawalId: string; reason: string }): Promise<void> {
  await db.begin(async (sql) => {
    const [w] = await sql<{ id: string; status: string; provider_ref: string | null }[]>`
      select id, status, provider_ref from public.withdrawals where id = ${p.withdrawalId} for update`;
    if (!w || w.status === "failed" || w.status === "reversed") return;
    if (w.status === "pending") { await failWithdrawal(sql, w.id, p.reason); return; }
    const ref = `${w.provider_ref ?? w.id}:reversed`;
    const lines = await sql<{ deal_id: string; amount_kobo: string }[]>`
      select deal_id, amount_kobo from public.payouts where withdrawal_id = ${w.id}`;
    const grp = randomUUID();
    const rows = lines.flatMap((l) => [
      { txn_group: grp, deal_id: l.deal_id, account: "seller_payable", amount_kobo: Number(l.amount_kobo), movement: "payout_reversal", provider_ref: ref },
      { txn_group: grp, deal_id: l.deal_id, account: "external", amount_kobo: -Number(l.amount_kobo), movement: "payout_reversal", provider_ref: ref },
    ]);
    await sql`
      insert into public.ledger_entries ${sql(rows, "txn_group", "deal_id", "account", "amount_kobo", "movement", "provider_ref")}
      on conflict do nothing`;
    await sql`update public.withdrawals set status = 'reversed', failure_reason = ${p.reason.slice(0, 300)}, updated_at = now() where id = ${w.id}`;
    await sql`update public.payouts set status = 'reversed' where withdrawal_id = ${w.id}`;
  });
}

/** Apply a transfer's state as Paystack reports it (webhook or poll). */
export async function applyTransferState(
  db: Sql,
  withdrawalId: string,
  t: { status: string; amount: number; reference: string; transfer_code?: string; fee_charged?: number; reason?: string },
  source: string,
): Promise<void> {
  if (t.status === "success") {
    try {
      const res = await settleWithdrawal(db, {
        withdrawalId, sentKobo: Number(t.amount), providerRef: String(t.transfer_code ?? t.reference),
        actualFeeKobo: t.fee_charged != null ? Number(t.fee_charged) : null,
      });
      if (!res.ok) await exception(db, source, `settle:${res.reason}`, { withdrawalId, reference: t.reference, amount: t.amount });
      else if (res.late) await exception(db, source, "late_success_after_failed", { withdrawalId, reference: t.reference });
    } catch (e) {
      // The balance trigger refused it: the seller withdrew these sales again after
      // this one was marked failed, and now both were paid. Ops recovers it.
      if ((e as { code?: string }).code === "23514")
        return exception(db, source, "late_success_overdrawn", { withdrawalId, reference: t.reference, message: (e as Error).message.slice(0, 300) });
      throw e;
    }
  } else if (t.status === "failed" || t.status === "abandoned") {
    if (await failWithdrawal(db, withdrawalId, `paystack: ${t.status}${t.reason ? ` · ${t.reason}` : ""}`))
      await exception(db, source, "transfer_not_completed", { withdrawalId, reference: t.reference, reason: t.reason ?? null });
  } else if (t.status === "reversed") {
    await reverseWithdrawal(db, { withdrawalId, reason: `paystack: reversed${t.reason ? ` · ${t.reason}` : ""}` });
    await exception(db, source, "transfer_reversed", { withdrawalId, reference: t.reference, reason: t.reason ?? null });
  }
  // pending / otp / received / queued: still on its way — the webhook or the poll decides.
}

/** A withdrawal's Paystack reference: derived from its id, so every retry reuses it and
 * Paystack refuses a duplicate rather than paying twice (lowercase, 39 chars). */
export const transferReference = (withdrawalId: string) => `wcp-wd-${withdrawalId.replace(/-/g, "")}`;

/**
 * Send a withdrawal (the escrow.withdrawal command). Paystack: a transfer of the NET to
 * the snapshotted recipient. Mock: settled at once, as the mock rail does for releases.
 * A refusal is verified with Paystack before the withdrawal is marked failed — a
 * transfer it did create must not have its sales freed for a second withdrawal.
 */
export async function processWithdrawal(db: Sql, withdrawalId: string): Promise<void> {
  const [w] = await db<{ id: string; status: string; rail: Rail; net_kobo: string; recipient_code: string | null; transfer_reference: string | null }[]>`
    select id, status, rail, net_kobo, recipient_code, transfer_reference from public.withdrawals where id = ${withdrawalId}`;
  if (!w || w.status !== "pending") return; // redelivery, or already resolved
  if (w.rail === "mock") {
    const res = await settleWithdrawal(db, { withdrawalId: w.id, sentKobo: Number(w.net_kobo), providerRef: `mock_wd_${w.id}` });
    if (!res.ok) await exception(db, "escrow.withdrawal", `settle:${res.reason}`, { withdrawalId: w.id });
    return;
  }
  if (!w.recipient_code) {
    await failWithdrawal(db, w.id, "no recipient");
    return exception(db, "escrow.withdrawal", "no_recipient", { withdrawalId: w.id });
  }
  const reference = w.transfer_reference ?? transferReference(w.id);
  if (!w.transfer_reference) await db`update public.withdrawals set transfer_reference = ${reference}, updated_at = now() where id = ${w.id}`;
  try {
    await initiateTransfer({ amountKobo: Number(w.net_kobo), recipientCode: w.recipient_code, reference, reason: "WCP Markets withdrawal" });
  } catch (e) {
    if (e instanceof PaystackError && /duplicate|already/i.test(e.message)) return; // the first try went through
    if (e instanceof PaystackError && e.status >= 400 && e.status < 500) {
      // Refused — but did Paystack make it anyway? Only a transfer it has no record of
      // is a failure; anything it knows about is settled by its webhook or the poll.
      let known: Awaited<ReturnType<typeof verifyTransfer>> | null = null;
      try {
        known = await verifyTransfer(reference);
      } catch (v) {
        if (!(v instanceof PaystackError && v.status >= 400 && v.status < 500)) throw v; // can't tell yet: SQS retries
      }
      if (known) return applyTransferState(db, w.id, known, "escrow.withdrawal");
      await failWithdrawal(db, w.id, `paystack refused: ${e.message}`);
      return exception(db, "escrow.withdrawal", "transfer_rejected", { withdrawalId: w.id, reference, message: e.message.slice(0, 300) });
    }
    throw e; // network / 5xx: SQS retries with the same reference
  }
}

/**
 * Sweeper: a Paystack withdrawal still pending after the grace period is asked about
 * directly, so a lost webhook can't leave a seller's money in limbo.
 */
export async function pollPendingWithdrawals(db: Sql, graceMins = 30): Promise<number> {
  const stuck = await db<{ id: string; transfer_reference: string }[]>`
    select id, transfer_reference from public.withdrawals
    where rail = 'paystack' and status = 'pending' and transfer_reference is not null
      and updated_at < now() - make_interval(mins => ${graceMins})
    order by updated_at limit 10`;
  for (const w of stuck) {
    try {
      const t = await verifyTransfer(w.transfer_reference);
      await applyTransferState(db, w.id, t, "withdrawal.poll");
      await db`update public.withdrawals set updated_at = now() where id = ${w.id} and status = 'pending'`;
    } catch (e) {
      console.warn(`[withdrawal] poll ${w.id}:`, (e as Error).message);
    }
  }
  return stuck.length;
}
