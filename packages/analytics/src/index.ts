/**
 * Analytics seam (F-7). A single `track()` entry point that every product
 * surface calls. For now it logs to the console; drop in a real provider
 * (PostHog / Segment / GA) behind this function later without touching callers.
 */

/** Canonical event names fired across the platform. Extend as needed. */
export type AnalyticsEvent =
  | "waitlist_submit"
  | "waitlist_intent"
  | "waitlist_success"
  | "section_view"
  | "faq_expand"
  | "cta_click";

export type AnalyticsProps = Record<
  string,
  string | number | boolean | null | undefined
>;

type Sink = (event: AnalyticsEvent, props?: AnalyticsProps) => void;

const consoleSink: Sink = (event, props) => {
  // eslint-disable-next-line no-console
  console.log(`[analytics] ${event}`, props ?? {});
};

let sink: Sink = consoleSink;

/** Swap the destination (e.g. wire PostHog in a client provider). */
export function setAnalyticsSink(next: Sink): void {
  sink = next;
}

/** Fire an analytics event. Safe to call anywhere; never throws. */
export function track(event: AnalyticsEvent, props?: AnalyticsProps): void {
  try {
    sink(event, props);
  } catch {
    // analytics must never break product flows
  }
}
