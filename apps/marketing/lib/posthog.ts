import "server-only";
import { PostHog } from "posthog-node";

function makeClient(): PostHog {
  return new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY!, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    // Next.js server actions are short-lived — flush immediately so events
    // are not lost when the invocation ends.
    flushAt: 1,
    flushInterval: 0,
    // Off: this is a per-request client; exception autocapture would register
    // process-level handlers on every invocation.
    enableExceptionAutocapture: false,
  });
}

/** Create a per-request PostHog client for use in server actions. */
export function getPostHogClient(): PostHog {
  return makeClient();
}
