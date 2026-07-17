"use client";

import { useEffect } from "react";
import { track } from "@wcp/analytics";

/**
 * Fires a `section_view` event the first time each section scrolls into view
 * (F-7). Pure side-effect component — renders nothing.
 */
export function SectionViewTracker({ ids }: { ids: string[] }) {
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const seen = new Set<string>();

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && !seen.has(entry.target.id)) {
            seen.add(entry.target.id);
            track("section_view", { id: entry.target.id });
            observer.unobserve(entry.target);
          }
        }
      },
      { threshold: 0.4 },
    );

    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);

  return null;
}
