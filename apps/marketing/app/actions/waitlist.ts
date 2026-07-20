"use server";

import { saveWaitlistEntry, type WaitlistIntent } from "@/lib/waitlist";
import { sendConfirmationEmail } from "@/lib/email";
import { getPostHogClient } from "@/lib/posthog";

export type JoinResult =
  | { ok: true; duplicate: boolean; alreadyConfirmed: boolean }
  | { ok: false; error: "invalid_email" | "storage_error" };

/**
 * Server action behind the email capture (F-1). Minimal validation (contains "@"),
 * then persists via the storage seam and — for a new or still-pending signup —
 * sends a double opt-in confirmation email. Duplicates are success (F-2). Email
 * sending is best-effort and never fails the join (the row is saved regardless).
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

  let confirmationSent = false;
  if (result.ok && result.token && (result.status === "pending" || result.status === "resend")) {
    confirmationSent = await sendConfirmationEmail({ email: email.toLowerCase(), token: result.token });
  }

  // Reliable server-side conversion event (survives client-side ad-blockers).
  // Analytics must NEVER break the join, so this is fully best-effort.
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
                  status: result.status,
                  confirmation_sent: confirmationSent,
                  $set: { email },
                },
              }
            : {
                distinctId: email,
                event: "waitlist_join_failed",
                properties: { intent: input.intent ?? null, error: result.error },
              },
        );
      } finally {
        await posthog.shutdown();
      }
    } catch {
      // ignore analytics failures
    }
  }

  if (!result.ok) return { ok: false, error: "storage_error" };
  return { ok: true, duplicate: result.duplicate, alreadyConfirmed: result.status === "already_confirmed" };
}
