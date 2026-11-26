import type { Sql } from "postgres";
import { deleteStorageObject } from "../supabase.js";
import { deliver } from "../notify/push.js";
import { getSmileId, type SmileId, type SmileStatus } from "./smileid.js";

/**
 * Smile ID attempts (0035): one per capture. An attempt is settled from the job's
 * status as Smile ID reports it — by webhook nudge, by the app saying it submitted, or
 * when GET /kyc finds one still processing — and settling is idempotent, so all three
 * can race. Only 'clear' verifies (L2); 'attention' is a manual-review case on Smile
 * ID's side and does not; 'block' fails; 'error' can be retried.
 */
export type Attempt = {
  id: string;
  user_id: string;
  id_type: "bvn" | "nin";
  id_hash: string | null;
  job_id: string | null;
  status: string;
  updated_at: Date;
};

const FINAL = new Set(["clear", "attention", "block", "error", "abandoned"]);

/** Write a terminal status once, and on 'clear' make the user L2 (as the mock match did). */
export async function settleAttempt(db: Sql, a: Attempt, status: SmileStatus, reason: string | null = null): Promise<void> {
  if (FINAL.has(a.status)) return;
  if (status === "processing" || status === "not_found") {
    await db`update public.kyc_attempts set status = 'processing', updated_at = now() where id = ${a.id} and status in ('started', 'processing')`;
    return;
  }
  let oldSelfie: string | null = null;
  let settled = false;
  await db.begin(async (sql) => {
    const [won] = await sql`
      update public.kyc_attempts set status = ${status}, reason = ${reason}, updated_at = now(), completed_at = now()
      where id = ${a.id} and status in ('started', 'processing') returning id`;
    if (!won) return; // someone else settled it first
    settled = true;
    const [old] = await sql<{ selfie_path: string | null; matched: boolean }[]>`
      select selfie_path, matched from public.kyc_verifications where user_id = ${a.user_id} for update`;
    if (status === "clear") {
      oldSelfie = old?.selfie_path ?? null;
      await sql`
        insert into public.kyc_verifications (user_id, id_type, matched, level, selfie_path, provider_ref, id_hash, updated_at)
        values (${a.user_id}, ${a.id_type}, true, 2, null, ${a.job_id}, ${a.id_hash}, now())
        on conflict (user_id) do update
          set id_type = excluded.id_type, matched = true, level = 2, selfie_path = null,
              provider_ref = excluded.provider_ref,
              id_hash = coalesce(excluded.id_hash, public.kyc_verifications.id_hash), updated_at = now()`;
      await sql`
        insert into public.profiles (id, verification_level) values (${a.user_id}, 2)
        on conflict (id) do update set verification_level = 2, updated_at = now()`;
    } else if (status === "block" && !old?.matched) {
      // Never downgrade a verified user; record a first-time failure like the mock did.
      await sql`
        insert into public.kyc_verifications (user_id, id_type, matched, level, provider_ref, updated_at)
        values (${a.user_id}, ${a.id_type}, false, 1, ${a.job_id}, now())
        on conflict (user_id) do update
          set id_type = excluded.id_type, matched = false, level = 1, provider_ref = excluded.provider_ref, updated_at = now()`;
    }
  });
  // The mock-era selfie is superseded — Smile ID holds the capture now (NDPA minimisation).
  if (oldSelfie) await deleteStorageObject("kyc-selfies", oldSelfie);
  // Only the call that settled it tells the person, so a webhook racing a poll can't
  // notify twice (deliver's dedupe key would stop it anyway).
  if (settled) await notifyResult(db, a, status);
}

/**
 * Tell the person how their check came out (push + the in-app list). Results usually
 * land in under a minute while they're watching Verify your identity — the app drops
 * the push then, as it does for the chat that's open — but a slow one can take far
 * longer, and they shouldn't have to keep reopening the screen to find out.
 */
const RESULT: Partial<Record<SmileStatus, { title: string; body: string }>> = {
  clear: { title: "You're verified", body: "Your ID check passed — payouts are unlocked." },
  attention: {
    title: "Your ID check needs another try",
    body: "I couldn't confirm it automatically. Try again in good, even light with your face fully in the frame.",
  },
  block: {
    title: "Your ID check didn't match",
    body: "Check the number, and that your names are exactly as on your BVN/NIN, then try again.",
  },
  error: { title: "Your ID check didn't finish", body: "I couldn't reach the ID service to finish it. Try again." },
};

async function notifyResult(db: Sql, a: Attempt, status: SmileStatus): Promise<void> {
  const text = RESULT[status];
  if (!text) return;
  try {
    // A payout is what this unlocks, so it goes out on the Orders & escrow channel.
    await deliver(db, { userId: a.user_id, topic: "orders", ...text, key: `kyc:${a.id}`, data: { type: "kyc" }, tag: "kyc" });
  } catch (e) {
    console.error(`[kyc] notify ${a.id}:`, (e as Error).message); // best-effort, like every push
  }
}

/**
 * The sweeper's job: settle checks still processing with nobody asking. The webhook
 * and the app's polling cover the usual case; this covers a missed webhook with the
 * app closed, which is when the result notification matters most. Each attempt is
 * asked about at most once a minute (settling 'processing' bumps updated_at), and
 * given up on after 3 days.
 */
export async function settleStaleAttempts(db: Sql): Promise<number> {
  const smile = await getSmileId();
  if (!smile) return 0;
  const rows = await db<Attempt[]>`
    select id, user_id, id_type, id_hash, job_id, status, updated_at from public.kyc_attempts
    where status = 'processing' and job_id is not null
      and updated_at < now() - interval '1 minute' and created_at > now() - interval '3 days'
    order by updated_at limit 10`;
  for (const a of rows) await refreshAttempt(db, smile, a);
  return rows.length;
}

/** Ask Smile ID where a submitted attempt stands, and settle it. Never throws. */
export async function refreshAttempt(db: Sql, smile: SmileId, a: Attempt, reason: string | null = null): Promise<void> {
  if (!a.job_id || FINAL.has(a.status)) return;
  try {
    await settleAttempt(db, a, await smile.status(a.job_id, a.user_id), reason);
  } catch (e) {
    console.error(`[kyc] status ${a.job_id}:`, (e as Error).message);
  }
}
