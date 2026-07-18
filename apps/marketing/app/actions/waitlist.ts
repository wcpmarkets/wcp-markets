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

  const posthog = getPostHogClient();
  const result = await saveWaitlistEntry({ email, intent: input.intent ?? null });

  try {
    if (result.ok) {
      posthog.capture({
        distinctId: email,
        event: "waitlist joined",
        properties: {
          intent: input.intent ?? null,
          duplicate: result.duplicate,
          $set: { email },
        },
      });
    } else {
      posthog.capture({
        distinctId: email,
        event: "waitlist join failed",
        properties: {
          intent: input.intent ?? null,
          error: result.error,
        },
      });
    }
  } finally {
    await posthog.shutdown();
  }

  return result;
}
