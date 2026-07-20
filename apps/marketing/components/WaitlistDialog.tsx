"use client";

import { useEffect, useRef } from "react";
import { cn } from "@wcp/ui";
import { useWaitlist } from "./WaitlistProvider";
import type { WaitlistIntent } from "@/lib/waitlist";

const OPTIONS: {
  value: Exclude<WaitlistIntent, null>;
  label: string;
  desc: string;
}[] = [
  { value: "buy", label: "Buy", desc: "Shop with escrow protection on every deal" },
  { value: "sell", label: "Sell", desc: "List it and get paid when confirmed" },
  { value: "both", label: "Both", desc: "I'll be buying and selling" },
];

/**
 * Intent picker shown after a valid email is submitted. Uses the native
 * <dialog> element (showModal) so focus-trapping, Escape-to-close, and the
 * backdrop come for free. Choosing an option submits immediately.
 */
export function WaitlistDialog() {
  const { dialogOpen, closeDialog, confirmIntent, submitting, submitError } =
    useWaitlist();
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (dialogOpen && !d.open) d.showModal();
    else if (!dialogOpen && d.open) d.close();
  }, [dialogOpen]);

  return (
    <dialog
      ref={ref}
      onClose={closeDialog}
      onClick={(e) => {
        // Click on the backdrop (the dialog element itself) closes it.
        if (e.target === ref.current && !submitting) closeDialog();
      }}
      aria-labelledby="waitlist-dialog-title"
      aria-describedby="waitlist-dialog-desc"
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-[440px] rounded-[20px] border border-line bg-panel p-0 text-ink",
        "max-h-[90vh] overflow-auto shadow-[0_40px_90px_rgba(124,92,255,.18),0_12px_30px_rgba(0,0,0,.6)]",
        "[&::backdrop]:bg-black/70 [&::backdrop]:backdrop-blur-sm",
      )}
    >
      <div className="p-6 sm:p-7">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="waitlist-dialog-title"
              className="text-[20px] font-bold tracking-[-0.4px]"
            >
              One quick thing
            </h2>
            <p
              id="waitlist-dialog-desc"
              className="mt-1 text-[13.5px] leading-[1.5] text-muted"
            >
              Are you joining to buy, sell, or both?
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={closeDialog}
            autoFocus
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border border-line text-muted transition-colors hover:border-line-hover hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-2.5">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              disabled={submitting}
              onClick={() => void confirmIntent(o.value)}
              className="group flex items-center gap-3 rounded-[14px] border border-line bg-canvas px-4 py-3 text-left transition-colors hover:border-brand-cyan disabled:opacity-60"
            >
              <span className="flex-1">
                <span className="block text-[15px] font-bold">{o.label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-[1.45] text-muted">
                  {o.desc}
                </span>
              </span>
              <span
                aria-hidden="true"
                className="text-faint transition-colors group-hover:text-brand-cyan"
              >
                →
              </span>
            </button>
          ))}
        </div>

        {submitError ? (
          <p className="mt-4 text-[12.5px] text-[#FF8886]" role="alert">
            {submitError}
          </p>
        ) : submitting ? (
          <p className="mt-4 text-[12.5px] text-muted">Joining…</p>
        ) : null}
      </div>
    </dialog>
  );
}
