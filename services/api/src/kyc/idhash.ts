import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchSsm } from "../secrets.js";

/**
 * A keyed hash of a BVN/NIN, so account recovery can check "the same ID as before"
 * without the number ever being stored. HMAC-SHA256 with a pepper held in SSM: an
 * 11-digit ID space is tiny, so an unkeyed hash would be brute-forced in seconds —
 * without the pepper the stored value is useless.
 *
 *   KYC_ID_PEPPER (local) or SSM KYC_ID_PEPPER_SSM (default /wcp/api/kyc-id-pepper)
 *
 * No pepper → null everywhere (fail closed): nothing is stored, recovery falls back
 * to an admin review, and payouts ask the seller to re-verify once one exists.
 */
let pepper: Promise<string | undefined> | null = null;
function getPepper(): Promise<string | undefined> {
  pepper ??= (async () =>
    process.env.KYC_ID_PEPPER ?? (await fetchSsm(process.env.KYC_ID_PEPPER_SSM ?? "/wcp/api/kyc-id-pepper")))();
  return pepper;
}

export async function idHash(idType: "bvn" | "nin", idNumber: string): Promise<string | null> {
  const key = await getPepper();
  if (!key) return null;
  return createHmac("sha256", key).update(`${idType}:${idNumber.replace(/\D/g, "")}`).digest("hex");
}

/** Is a pepper configured? (Payouts only ask for a re-verify when one is.) */
export async function hasPepper(): Promise<boolean> {
  return !!(await getPepper());
}

/** Constant-time compare of two stored/derived hashes. */
export function sameHash(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
