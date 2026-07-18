"use client";

import { GradientButton, cn } from "@wcp/ui";
import { useWaitlist } from "./WaitlistProvider";
import { waitlistNotes } from "@/lib/content";

/**
 * Shared email-capture row (F-1) used in the hero and the waitlist section.
 * Both instances read the same context, so submitting in one converts both.
 * Clicking "Join the waitlist" validates the email, then opens the intent
 * dialog (see WaitlistDialog). Once joined, the form is replaced by a success
 * chip (same in both places). `align="center"` centers the row.
 */
export function EmailCapture({
  source,
  align = "start",
}: {
  source: "hero" | "waitlist";
  align?: "start" | "center";
}) {
  const { email, setEmail, joined, error, clearError, requestJoin } =
    useWaitlist();

  // After joining, both the hero and the waitlist section show the same chip.
  if (joined) {
    return (
      <div className={cn(align === "center" && "text-center")}>
        <div className="inline-flex items-center gap-2.5 rounded-[14px] border border-brand-cyan bg-panel px-[26px] py-4 text-[14.5px] text-ink">
          <span className="text-[16px] text-brand-cyan" aria-hidden="true">
            ✓
          </span>
          {waitlistNotes.successChip}
        </div>
      </div>
    );
  }

  return (
    <div className={cn(align === "center" && "mx-auto max-w-[480px]")}>
      <form
        className={cn(
          // Stack input above button on mobile so the field is full-width and
          // readable; side-by-side from `sm` up.
          "flex max-w-[480px] flex-col gap-2.5 sm:flex-row",
          align === "center" && "mx-auto",
        )}
        onSubmit={(e) => {
          e.preventDefault();
          requestJoin(source);
        }}
        noValidate
      >
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            if (error) clearError();
            setEmail(e.target.value);
          }}
          placeholder={error ?? "you@example.com"}
          aria-label="Email address"
          aria-invalid={error ? true : undefined}
          className={cn(
            // 16px on mobile prevents iOS Safari from auto-zooming (and shifting
            // the layout) on focus; step down to the design's 14px on desktop.
            "w-full min-w-0 flex-1 rounded-[13px] border bg-panel px-[18px] py-[15px] text-[16px] text-ink outline-none focus:border-line-hover md:text-[14px]",
            error
              ? "border-[#FF8886] placeholder:text-[#FF8886]"
              : "border-line placeholder:text-faint",
          )}
        />
        <GradientButton
          type="submit"
          size="lg"
          className="w-full sm:w-auto"
        >
          Join the waitlist
        </GradientButton>
      </form>

      {/* Error is shown inline as the field's red placeholder; keep a
          screen-reader-only announcement here for accessibility. */}
      {error && (
        <p className="sr-only" role="alert">
          {error}
        </p>
      )}

      {source === "hero" && (
        <p className="mt-3 text-[12px] text-faint">{waitlistNotes.notJoined}</p>
      )}
    </div>
  );
}
