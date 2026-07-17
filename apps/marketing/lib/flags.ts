/**
 * Launch-day feature flags (F-5). Booleans that gate the announcement bar and
 * the hero email form. In Phase 2+ these move to remote config; for now they are
 * simple constants (optionally overridable by env for preview builds).
 */
export const flags = {
  /** Show the top announcement strip. */
  showAnnouncement: process.env.NEXT_PUBLIC_SHOW_ANNOUNCEMENT !== "false",
  /** Show the hero email-capture form (turn off once the app is live). */
  waitlistOpen: process.env.NEXT_PUBLIC_WAITLIST_OPEN !== "false",
} as const;
