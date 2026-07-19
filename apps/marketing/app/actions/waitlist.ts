"use server";

import { saveWaitlistEntry, type WaitlistIntent } from "@/lib/waitlist";
import { getPostHogClient } from "@/lib/posthog";

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

  const result = await saveWaitlistEntry({ email, intent: input.intent ?? null });

  // Reliable server-side conversion event (survives client-side ad-blockers).
  // Analytics must NEVER break the join, so this is fully best-effort: guarded
  // on the key, and any capture/flush error is swallowed.
  if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    try {
      const posthog = getPostHogClient();
      try {
        posthog.capture(
          result.ok
            ? {
                distinctId: email,
                event: "waitlist_joined",
                properties: {
                  intent: input.intent ?? null,
                  duplicate: result.duplicate,
                  $set: { email },
                },
              }
            : {
                distinctId: email,
                event: "waitlist_join_failed",
                properties: {
                  intent: input.intent ?? null,
                  error: result.error,
                },
              },
        );
      } finally {
        await posthog.shutdown();
      }
    } catch {
      // ignore analytics failures
    }
  }

  return result;
}
