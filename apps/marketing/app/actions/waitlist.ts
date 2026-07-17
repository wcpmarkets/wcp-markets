"use server";

import { saveWaitlistEntry, type WaitlistIntent } from "@/lib/waitlist";

export type JoinResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: "invalid_email" | "storage_error" };

/**
 * Server action behind the email capture (F-1). Minimal validation (contains
 * "@", matching the prototype), then persists via the storage seam. Duplicates
 * are treated as success (F-2).
 */
export async function joinWaitlist(input: {
  email: string;
  intent: WaitlistIntent;
}): Promise<JoinResult> {
  const email = (input.email ?? "").trim();
  if (!email.includes("@")) {
    return { ok: false, error: "invalid_email" };
  }
  return saveWaitlistEntry({ email, intent: input.intent ?? null });
}
