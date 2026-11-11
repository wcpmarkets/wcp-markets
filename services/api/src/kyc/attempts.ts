import type { Sql } from "postgres";
import { deleteStorageObject } from "../supabase.js";
import type { SmileId, SmileStatus } from "./smileid.js";

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
  await db.begin(async (sql) => {
    const [won] = await sql`
      update public.kyc_attempts set status = ${status}, reason = ${reason}, updated_at = now(), completed_at = now()
      where id = ${a.id} and status in ('started', 'processing') returning id`;
    if (!won) return; // someone else settled it first
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
