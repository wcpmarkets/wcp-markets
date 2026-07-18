"use client";

import { useEffect } from "react";
import posthog from "posthog-js";
import { setAnalyticsSink } from "@wcp/analytics";

/**
 * Initializes PostHog on the client and routes the shared `track()` seam
 * (@wcp/analytics) to `posthog.capture`. If no key is set (e.g. local dev),
 * this is a no-op and `track()` keeps logging to the console.
 *
 * Renders nothing.
 */
export function AnalyticsProvider() {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    if (!key) return;

    posthog.init(key, {
      api_host:
        process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      person_profiles: "identified_only",
    });

    // Send every track(event, props) call to PostHog.
    setAnalyticsSink((event, props) => {
      posthog.capture(event, props);
    });
  }, []);

  return null;
}
