import { randomInt } from "node:crypto";
import type { Sql } from "postgres";
import { getKycProvider } from "../kyc/provider.js";
import { idHash, sameHash } from "../kyc/idhash.js";
import { sendSecuritySms } from "../sms/provider.js";
import { maskEmail, maskName, maskPhone } from "./phone.js";

/**
 * Account recovery (designs 20j-recover-1…4).
 *
 * The requester has ALREADY signed in with their new number (a normal Supabase OTP),
 * so they hold a fresh, empty placeholder account — that is the proof they control
 * the new number, and it means the lookup below is never unauthenticated (no number
 * enumeration by anonymous callers; it is also rate-limited).
 *
 *   start      lost number → the account it's registered to → branch:
 *                seller (L2, can withdraw escrow) — re-enter the same BVN/NIN
 *                basic  — the last order + the account's email, if any
 *              No facts to check (or a seller with no stored ID hash) → admin review.
 *   answer     ≤ MAX_ATTEMPTS tries, then failed.
 *   holding    24h; both numbers get an SMS, the owner sees a banner and can cancel,
 *              the account's payouts are paused (routes/kyc.ts).
 *   complete   the sweeper (completeDueRecoveries) moves the new number onto the old
 *              account, deletes the placeholder and signs every old session out.
 */
export const MAX_ATTEMPTS = 3;
export const HOLD_HOURS = 24;
export const OPEN = ["identity", "review", "holding"] as const;

export type Branch = "seller" | "basic";
export type Status = "identity" | "review" | "holding" | "completed" | "cancelled" | "failed";

/** A question as stored (with its answer key) — `answer` never leaves the server. */
type StoredQuestion =
  | { id: "last_order"; kind: "choice"; prompt: string; options: { id: string; label: string }[]; answer: string }
  | { id: "email"; kind: "text"; prompt: string; hint: string; answer: string };

export type RecoveryRow = {
  id: string;
  account_id: string;
  requester_id: string | null;
  lost_phone: string;
  new_phone: string;
  branch: Branch;
  status: Status;
  questions: StoredQuestion[] | null;
  attempts: number;
  hold_until: Date | null;
  closed_reason: string | null;
  created_at: Date;
};

/** What the requester sees: the account only as a recogniser, questions without answers. */
export function toRequesterView(r: RecoveryRow, displayName: string | null) {
  return {
    id: r.id,
    status: r.status,
    branch: r.branch,
    accountName: maskName(displayName),
    lostPhone: maskPhone(r.lost_phone),
    newPhone: maskPhone(r.new_phone),
    questions: (r.questions ?? []).map((q) =>
      q.kind === "choice"
        ? { id: q.id, kind: q.kind, prompt: q.prompt, options: q.options, hint: null }
        : { id: q.id, kind: q.kind, prompt: q.prompt, options: null, hint: q.hint },
    ),
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - r.attempts),
    holdUntil: r.hold_until?.toISOString() ?? null,
    closedReason: r.closed_reason,
    createdAt: r.created_at.toISOString(),
  };
}

/** What the account's current owner sees on their banner: who it's moving to, and when. */
export function toOwnerView(r: RecoveryRow) {
  return {
    id: r.id,
    status: r.status,
    newPhone: maskPhone(r.new_phone),
    holdUntil: r.hold_until?.toISOString() ?? null,
    createdAt: r.created_at.toISOString(),
  };
}

const COLS = "id, account_id, requester_id, lost_phone, new_phone, branch, status, questions, attempts, hold_until, closed_reason, created_at";

export async function getRecovery(db: Sql, id: string): Promise<RecoveryRow | null> {
  const [r] = await db<RecoveryRow[]>`select ${db.unsafe(COLS)} from public.account_recoveries where id = ${id}`;
  return r ?? null;
}

/** The requester's open request, else their most recent one. */
export async function requesterRecovery(db: Sql, requesterId: string): Promise<RecoveryRow | null> {
  const [r] = await db<RecoveryRow[]>`
    select ${db.unsafe(COLS)} from public.account_recoveries where requester_id = ${requesterId}
    order by (status in ('identity', 'review', 'holding')) desc, created_at desc limit 1`;
  return r ?? null;
}

/** An open recovery AGAINST this account (the owner's banner). Only once it's past the
 * lookup step — an unanswered request is noise the owner can't judge yet. */
export async function ownerRecovery(db: Sql, accountId: string): Promise<RecoveryRow | null> {
  const [r] = await db<RecoveryRow[]>`
    select ${db.unsafe(COLS)} from public.account_recoveries
    where account_id = ${accountId} and status in ('review', 'holding') limit 1`;
  return r ?? null;
}

/** True while this account has a recovery in review or holding — payouts wait for it. */
export async function payoutsPausedByRecovery(db: Sql, accountId: string): Promise<boolean> {
  const [r] = await db`select 1 from public.account_recoveries where account_id = ${accountId} and status in ('review', 'holding') limit 1`;
  return !!r;
}

/**
 * Does this account hold nothing? The placeholder must be empty — it is deleted at
 * transfer, and anything on it (a listing, a chat, a KYC record) would go with it.
 */
export async function isFreshAccount(db: Sql, userId: string): Promise<boolean> {
  const [r] = await db<{ busy: boolean }[]>`
    select exists (select 1 from public.listings where seller_id = ${userId})
        or exists (select 1 from public.deals where buyer_id = ${userId} or seller_id = ${userId})
        or exists (select 1 from public.conversations where buyer_id = ${userId} or seller_id = ${userId})
        or exists (select 1 from public.kyc_verifications where user_id = ${userId})
        or exists (select 1 from public.quote_requests where buyer_id = ${userId} or seller_id = ${userId})
        or exists (select 1 from public.staff_roles where user_id = ${userId})
        or exists (select 1 from public.reviews where reviewer_id = ${userId} or seller_id = ${userId})
        as busy`;
  return !r!.busy;
}

export type StartError =
  | "no_phone"            // the caller's own account has no phone (email-only sign-in)
  | "same_number"         // the "lost" number is the one they're signed in with
  | "not_fresh"           // the caller's account already has activity — recovery needs an empty one
  | "not_found"           // no account on that number
  | "in_progress";        // someone else already has an open recovery for that account

/** Start (or resume) a recovery as the signed-in placeholder account. */
export async function startRecovery(
  db: Sql,
  requesterId: string,
  lostPhone: string,
): Promise<{ ok: true; row: RecoveryRow; displayName: string | null } | { ok: false; error: StartError }> {
  const [me] = await db<{ phone: string | null }[]>`select phone from auth.users where id = ${requesterId}`;
  const myPhone = me?.phone || null;
  if (!myPhone) return { ok: false, error: "no_phone" };
  if (myPhone === lostPhone) return { ok: false, error: "same_number" };

  // Resume the caller's own open request (an app restart mid-flow) if it's for this number.
  const mine = await requesterRecovery(db, requesterId);
  if (mine && (OPEN as readonly string[]).includes(mine.status) && mine.lost_phone === lostPhone) {
    return { ok: true, row: mine, displayName: await displayNameOf(db, mine.account_id) };
  }
  if (!(await isFreshAccount(db, requesterId))) return { ok: false, error: "not_fresh" };

  const [acct] = await db<{ id: string; email: string | null }[]>`
    select id, nullif(email, '') as email from auth.users where phone = ${lostPhone} and deleted_at is null`;
  if (!acct || acct.id === requesterId) return { ok: false, error: "not_found" };

  const [kyc] = await db<{ matched: boolean; id_hash: string | null }[]>`
    select matched, id_hash from public.kyc_verifications where user_id = ${acct.id}`;
  const branch: Branch = kyc?.matched ? "seller" : "basic";

  let questions: StoredQuestion[] | null = null;
  let status: Status = "identity";
  if (branch === "seller") {
    // Without a stored hash there's nothing to compare the ID against: they still enter
    // it (the provider must match it), then an admin decides.
    status = "identity";
  } else {
    questions = await buildQuestions(db, acct.id, acct.email);
    // Nothing account-specific to ask (no order, no email) → a person checks instead.
    if (!questions.some((q) => q.id === "email" || (q.id === "last_order" && q.answer !== "none"))) {
      questions = null;
      status = "review";
    }
  }

  try {
    const row = await db.begin(async (sql) => {
      // A previous request by this caller that's still open (for a different number) is
      // superseded — one open request per requester.
      await sql`
        update public.account_recoveries set status = 'cancelled', closed_reason = 'superseded', closed_at = now(), updated_at = now()
        where requester_id = ${requesterId} and status in ('identity', 'review', 'holding')`;
      const [r] = await sql<RecoveryRow[]>`
        insert into public.account_recoveries (account_id, requester_id, lost_phone, new_phone, branch, status, questions)
        values (${acct.id}, ${requesterId}, ${lostPhone}, ${myPhone}, ${branch}, ${status}, ${questions ? sql.json(questions as never) : null})
        returning ${sql.unsafe(COLS)}`;
      return r!;
    });
    if (row.status === "review") await alertReview(db, row);
    return { ok: true, row, displayName: await displayNameOf(db, acct.id) };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return { ok: false, error: "in_progress" };
    throw e;
  }
}

async function displayNameOf(db: Sql, userId: string): Promise<string | null> {
  const [p] = await db<{ display_name: string | null }[]>`select display_name from public.profiles where id = ${userId}`;
  return p?.display_name ?? null;
}

/** Last order + decoys (20j-recover-3-basic), and the full email if the account has one. */
async function buildQuestions(db: Sql, accountId: string, email: string | null): Promise<StoredQuestion[]> {
  const [last] = await db<{ title: string }[]>`
    select l.title from public.deals d join public.listings l on l.id = d.listing_id
    where d.buyer_id = ${accountId} order by d.created_at desc limit 1`;
  // Decoys: titles of other recent listings, so the options look like real purchases.
  const pool = await db<{ title: string }[]>`
    select distinct on (lower(title)) title from public.listings
    where seller_id <> ${accountId} and status = 'active'
    order by lower(title), created_at desc limit 60`;
  const decoys = shuffle(pool.map((p) => p.title).filter((t) => t.toLowerCase() !== last?.title.toLowerCase())).slice(0, 3);
  const labels = shuffle(last ? [last.title, ...decoys] : decoys);
  const options = labels.map((label, i) => ({ id: `o${i + 1}`, label }));
  options.push({ id: "none", label: "I haven't ordered yet" });
  const answer = last ? options.find((o) => o.label === last.title)!.id : "none";

  const qs: StoredQuestion[] = [{ id: "last_order", kind: "choice", prompt: "What did you last order on WCP?", options, answer }];
  if (email) qs.push({ id: "email", kind: "text", prompt: "The email on your account", hint: maskEmail(email), answer: email.trim().toLowerCase() });
  return qs;
}

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export type AnswerInput = {
  idType?: "bvn" | "nin";
  idNumber?: string;
  answers?: { questionId: string; value: string }[];
};
export type AnswerError = "not_found" | "wrong_state" | "missing_answer";

/** Check the requester's proof. Right → holding (or review); wrong → attempt used. */
export async function answerRecovery(
  db: Sql,
  requesterId: string,
  id: string,
  input: AnswerInput,
): Promise<{ ok: true; row: RecoveryRow; correct: boolean } | { ok: false; error: AnswerError }> {
  const pre = await getRecovery(db, id);
  if (!pre || pre.requester_id !== requesterId) return { ok: false, error: "not_found" };
  if (pre.status !== "identity") return { ok: false, error: "wrong_state" };

  let correct = false;
  let toReview = false;
  if (pre.branch === "seller") {
    if (!input.idType || !input.idNumber) return { ok: false, error: "missing_answer" };
    const [kyc] = await db<{ id_type: string; id_hash: string | null }[]>`
      select id_type, id_hash from public.kyc_verifications where user_id = ${pre.account_id}`;
    // The number goes to the provider and the HMAC in memory; it is never stored.
    const digits = input.idNumber.replace(/\D/g, ""); // "222 333 444 55" is the same ID
    const provider = await getKycProvider().verifyIdentity({ idType: input.idType, idNumber: digits });
    const h = await idHash(input.idType, digits);
    if (kyc?.id_hash) correct = provider.matched && sameHash(h, kyc.id_hash);
    else {
      // Verified before hashes were kept: a valid ID is necessary but not sufficient.
      correct = provider.matched;
      toReview = correct;
    }
  } else {
    const given = new Map((input.answers ?? []).map((a) => [a.questionId, a.value.trim()]));
    const qs = pre.questions ?? [];
    if (qs.some((q) => !given.get(q.id))) return { ok: false, error: "missing_answer" };
    correct = qs.every((q) => (q.kind === "text" ? given.get(q.id)!.toLowerCase() === q.answer : given.get(q.id) === q.answer));
  }

  const row = await db.begin(async (sql) => {
    const [cur] = await sql<RecoveryRow[]>`select ${sql.unsafe(COLS)} from public.account_recoveries where id = ${id} for update`;
    if (!cur || cur.status !== "identity") return null;
    if (correct && toReview) {
      const [r] = await sql<RecoveryRow[]>`
        update public.account_recoveries set status = 'review', updated_at = now()
        where id = ${id} returning ${sql.unsafe(COLS)}`;
      return r!;
    }
    if (correct) {
      const [r] = await sql<RecoveryRow[]>`
        update public.account_recoveries set status = 'holding', hold_until = now() + make_interval(hours => ${HOLD_HOURS}), updated_at = now()
        where id = ${id} returning ${sql.unsafe(COLS)}`;
      return r!;
    }
    const attempts = cur.attempts + 1;
    const [r] = await sql<RecoveryRow[]>`
      update public.account_recoveries
      set attempts = ${attempts},
          status = case when ${attempts} >= ${MAX_ATTEMPTS} then 'failed' else status end,
          closed_reason = case when ${attempts} >= ${MAX_ATTEMPTS} then 'attempts' else closed_reason end,
          closed_at = case when ${attempts} >= ${MAX_ATTEMPTS} then now() else closed_at end,
          updated_at = now()
      where id = ${id} returning ${sql.unsafe(COLS)}`;
    return r!;
  });
  if (!row) return { ok: false, error: "wrong_state" };
  if (row.status === "holding") await alertHoldStarted(db, row);
  if (row.status === "review") await alertReview(db, row);
  return { ok: true, row, correct };
}

/** Cancel an open request — by its requester, the account owner, or an admin. */
export async function cancelRecovery(db: Sql, id: string, by: "requester" | "owner" | "admin"): Promise<RecoveryRow | null> {
  const [row] = await db<RecoveryRow[]>`
    update public.account_recoveries
    set status = ${by === "admin" ? "failed" : "cancelled"}, closed_reason = ${by}, closed_at = now(), updated_at = now()
    where id = ${id} and status in ('identity', 'review', 'holding')
    returning ${db.unsafe(COLS)}`;
  if (!row) return null;
  // Only tell the numbers about a request that got far enough to have alerted them.
  if (by !== "requester" || row.hold_until) {
    const body = by === "owner"
      ? "WCP Markets: the request to move your account to a new number was cancelled by the account holder. No changes were made."
      : "WCP Markets: the request to move your account to a new number was cancelled. No changes were made.";
    await sendSecuritySms(db, { to: row.lost_phone, kind: "recovery_cancelled", body, recoveryId: row.id });
    await sendSecuritySms(db, { to: row.new_phone, kind: "recovery_cancelled", body: "WCP Markets: your account recovery request was cancelled. No changes were made.", recoveryId: row.id });
  }
  return row;
}

/** Admin approves a reviewed request → the same 24h hold as an automatic pass. */
export async function approveRecovery(db: Sql, id: string): Promise<RecoveryRow | null> {
  const [row] = await db<RecoveryRow[]>`
    update public.account_recoveries
    set status = 'holding', hold_until = now() + make_interval(hours => ${HOLD_HOURS}), closed_reason = null, updated_at = now()
    where id = ${id} and status = 'review'
    returning ${db.unsafe(COLS)}`;
  if (row) await alertHoldStarted(db, row);
  return row ?? null;
}

const fmtHold = (d: Date) =>
  d.toLocaleString("en-NG", { timeZone: "Africa/Lagos", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

async function alertHoldStarted(db: Sql, r: RecoveryRow) {
  const when = fmtHold(r.hold_until!);
  // To the old number: the owner (if they still hold it) is the one who can stop this.
  await sendSecuritySms(db, {
    to: r.lost_phone,
    kind: "recovery_started",
    body: `WCP Markets: someone asked to move your account to ${maskPhone(r.new_phone)}. It moves on ${when} unless you cancel. Not you? Open the WCP app now and tap Cancel.`,
    recoveryId: r.id,
  });
  await sendSecuritySms(db, {
    to: r.new_phone,
    kind: "recovery_started",
    body: `WCP Markets: your account will move to this number on ${when}. Payouts are paused until then. We've alerted the old number.`,
    recoveryId: r.id,
  });
}

async function alertReview(db: Sql, r: RecoveryRow) {
  await sendSecuritySms(db, {
    to: r.lost_phone,
    kind: "recovery_review",
    body: `WCP Markets: someone asked to move your account to ${maskPhone(r.new_phone)}. Our team is reviewing it. Not you? Open the WCP app and tap Cancel.`,
    recoveryId: r.id,
  });
}

/**
 * Sweeper job: transfer every recovery whose hold has run out. One transaction each:
 * the placeholder is re-checked empty and deleted (freeing its number — auth.users.phone
 * is unique), the number moves onto the recovered account, and every one of that
 * account's sessions is deleted (refresh tokens go with them; access tokens die at the
 * API's session check). Phone identities are keyed by user id, so nothing else moves.
 */
export async function completeDueRecoveries(db: Sql): Promise<{ completed: number; failed: number }> {
  let completed = 0;
  let failed = 0;
  for (let i = 0; i < 20; i++) {
    const outcome = await db.begin(async (sql) => {
      const [r] = await sql<RecoveryRow[]>`
        select ${sql.unsafe(COLS)} from public.account_recoveries
        where status = 'holding' and hold_until <= now()
        order by hold_until limit 1 for update skip locked`;
      if (!r) return null;
      const fail = async (reason: string) => {
        await sql`update public.account_recoveries set status = 'failed', closed_reason = ${reason}, closed_at = now(), updated_at = now() where id = ${r.id}`;
        return { r, ok: false as const, reason };
      };
      const [acct] = await sql<{ phone: string | null }[]>`select phone from auth.users where id = ${r.account_id} for update`;
      // The owner changed their number during the hold — they're clearly in control.
      if (!acct || acct.phone !== r.lost_phone) return fail("account_changed");
      if (r.requester_id) {
        const [req] = await sql<{ phone: string | null }[]>`select phone from auth.users where id = ${r.requester_id} for update`;
        if (!req || req.phone !== r.new_phone) return fail("requester_changed");
        if (!(await isFreshAccount(sql as unknown as Sql, r.requester_id))) return fail("requester_not_empty");
        await sql`delete from auth.users where id = ${r.requester_id}`;
      } else {
        // The placeholder is gone already; the number must still be free.
        const [taken] = await sql`select 1 from auth.users where phone = ${r.new_phone}`;
        if (taken) return fail("number_taken");
      }
      await sql`update auth.users set phone = ${r.new_phone}, phone_confirmed_at = now(), updated_at = now() where id = ${r.account_id}`;
      await sql`update public.profiles set phone = ${r.new_phone}, updated_at = now() where id = ${r.account_id}`;
      await sql`delete from auth.sessions where user_id = ${r.account_id}`;
      await sql`update public.account_recoveries set status = 'completed', closed_reason = 'transferred', closed_at = now(), updated_at = now() where id = ${r.id}`;
      return { r, ok: true as const, reason: "transferred" };
    });
    if (!outcome) break;
    const { r } = outcome;
    if (outcome.ok) {
      completed++;
      await sendSecuritySms(db, { to: r.new_phone, kind: "recovery_completed", body: "WCP Markets: your account is now on this number. Sign in with it to continue. Every other device has been signed out.", recoveryId: r.id });
      await sendSecuritySms(db, { to: r.lost_phone, kind: "recovery_completed", body: `WCP Markets: your account was moved to ${maskPhone(r.new_phone)} and this number was removed from it. Not you? Contact support.`, recoveryId: r.id });
    } else {
      failed++;
      console.warn(`[recovery] ${r.id} not transferred: ${outcome.reason}`);
    }
  }
  return { completed, failed };
}
