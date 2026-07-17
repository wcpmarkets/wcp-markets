"use client";

import { GradientButton, cn } from "@wcp/ui";
import { useWaitlist } from "./WaitlistProvider";
import { waitlistNotes } from "@/lib/content";

/**
 * Shared email-capture row (F-1) used in the hero and the waitlist section.
 * Both instances read the same context, so submitting in one converts both.
 * `align="center"` centers the row (waitlist variant).
 */
export function EmailCapture({
  source,
  align = "start",
}: {
  source: "hero" | "waitlist";
  align?: "start" | "center";
}) {
  const { email, setEmail, joined, submitting, error, clearError, submit } =
    useWaitlist();

  return (
    <div className={cn(align === "center" && "mx-auto max-w-[480px]")}>
      <form
        className={cn(
          "flex max-w-[480px] gap-2.5",
          align === "center" && "mx-auto",
        )}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(source);
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
            "w-full min-w-0 flex-1 rounded-[13px] border bg-panel px-[18px] py-[15px] text-[14px] text-ink outline-none focus:border-line-hover",
            error
              ? "border-[#FF8886] placeholder:text-[#FF8886]"
              : "border-line placeholder:text-faint",
          )}
        />
        <GradientButton type="submit" size="lg" disabled={submitting}>
          {submitting ? "Joining…" : "Join the waitlist"}
        </GradientButton>
      </form>

      {source === "hero" && (
        <p className="mt-3 text-[12px] text-faint">
          {joined ? waitlistNotes.joinedHero : waitlistNotes.notJoined}
        </p>
      )}
    </div>
  );
}
