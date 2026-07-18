"use client";

import { GradientButton, cn } from "@wcp/ui";
import { useWaitlist } from "./WaitlistProvider";
import { waitlistNotes } from "@/lib/content";
import type { WaitlistIntent } from "@/lib/waitlist";

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
  const {
    email,
    setEmail,
    intent,
    setIntent,
    joined,
    submitting,
    error,
    intentError,
    clearError,
    submit,
  } = useWaitlist();

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
          disabled={submitting}
          className="w-full sm:w-auto"
        >
          {submitting ? "Joining…" : "Join the waitlist"}
        </GradientButton>
      </form>

      <IntentSelect
        intent={intent}
        onChange={setIntent}
        align={align}
        invalid={intentError}
      />

      {/* Error is shown inline as the field's red placeholder; keep a
          screen-reader-only announcement here for accessibility. */}
      {error && (
        <p className="sr-only" role="alert">
          {error}
        </p>
      )}

      {source === "hero" && !error && (
        <p className="mt-3 text-[12px] text-faint">
          {joined ? waitlistNotes.joinedHero : waitlistNotes.notJoined}
        </p>
      )}
    </div>
  );
}

/** Required buyer/seller intent (F-3). Single-select; tap again to clear. */
function IntentSelect({
  intent,
  onChange,
  align,
  invalid,
}: {
  intent: WaitlistIntent;
  onChange: (value: WaitlistIntent) => void;
  align: "start" | "center";
  invalid: boolean;
}) {
  const options: { value: Exclude<WaitlistIntent, null>; label: string }[] = [
    { value: "buy", label: "Buy" },
    { value: "sell", label: "Sell" },
    { value: "both", label: "Both" },
  ];
  return (
    <div
      className={cn(
        "mt-3 flex flex-wrap items-center gap-2",
        align === "center" && "justify-center",
      )}
    >
      <span className={cn("text-[12px]", invalid ? "text-[#FF8886]" : "text-faint")}>
        {invalid ? "Pick one to continue:" : "I want to"}
      </span>
      {options.map((opt) => {
        const active = intent === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(active ? null : opt.value)}
            className={cn(
              "rounded-[999px] border px-[13px] py-[5px] text-[12px] transition-colors",
              active
                ? "border-brand-cyan text-brand-cyan"
                : invalid
                  ? "border-[#FF8886] text-ink-secondary"
                  : "border-line text-muted hover:border-line-hover",
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
