"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { track } from "@wcp/analytics";
import { escrowCard } from "@/lib/content";

type Step = { label: string; glyph: string; state: "done" | "active" | "todo" };

const IDLE_STEPS = escrowCard.steps as readonly Step[];
const RELEASED_STEPS: readonly Step[] = [
  { label: "Agreed", glyph: "✓", state: "done" },
  { label: "In escrow", glyph: "🔒", state: "done" },
  { label: "Inspect", glyph: "✓", state: "done" },
  { label: "Released", glyph: "✓", state: "done" },
];

/**
 * The hero "Escrow deal" card — a visual of the product's core loop. Clicking
 * "Confirm receipt & release" plays a small, non-committal demo: the progress
 * rail fills to the end and the card reads "Released", then reverts after a
 * couple of seconds. Pure eye-candy — no real state change.
 */
export function EscrowCard() {
  const [released, setReleased] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  function handleRelease() {
    if (released) return;
    track("cta_click", { location: "escrow_card_demo" });
    setReleased(true);
    timer.current = setTimeout(() => setReleased(false), 2600);
  }

  const steps = released ? RELEASED_STEPS : IDLE_STEPS;

  return (
    <div className="relative mx-auto w-full max-w-[342px]">
      {/* Soft glow behind the card */}
      <div
        className="pointer-events-none absolute -inset-y-8 -inset-x-[22px] blur-[8px]"
        style={{
          background:
            "radial-gradient(58% 44% at 50% 20%, rgba(124,92,255,.30), transparent 70%)",
        }}
      />

      {/* Floating "Buyer protected" badge */}
      <div
        className="absolute -top-[13px] right-4 z-[2] flex items-center gap-1.5 rounded-[999px] border bg-panel px-3 py-[7px] text-[10.5px] font-bold text-lime"
        style={{
          borderColor: "rgba(163,230,53,.5)",
          boxShadow: "0 8px 22px rgba(0,0,0,.5)",
        }}
      >
        <span>🛡</span>
        {escrowCard.badge}
      </div>

      <div className="wcp-panel-deep wcp-escrow-shadow relative rounded-[24px] border border-line p-[22px]">
        {/* Header row */}
        <div className="flex items-center gap-[9px]">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] text-[13px]">
            🔒
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-bold tracking-[-0.2px]">
              Escrow deal
            </div>
            <div className="text-[10.5px] text-faint">{escrowCard.ref}</div>
          </div>
          <StatusPill released={released} />
        </div>

        {/* Item row */}
        <div className="mt-[18px] flex items-center gap-3">
          <div className="relative h-[52px] w-[52px] shrink-0 overflow-hidden rounded-[13px] border border-line">
            <Image
              src="/ps5.png"
              alt="PS5 · Disc Edition"
              fill
              sizes="52px"
              className="object-cover"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-bold">{escrowCard.item.title}</div>
            <div className="mt-0.5 text-[11px] text-muted">
              {escrowCard.item.meta}
            </div>
          </div>
        </div>

        {/* Amount block */}
        <div
          className="mt-[18px] rounded-[16px] border px-[18px] py-4 text-center"
          style={{
            background: "rgba(124,92,255,.07)",
            borderColor: "rgba(124,92,255,.28)",
          }}
        >
          <div className="text-[10px] font-semibold tracking-[0.08em] text-muted">
            {escrowCard.amountLabel}
          </div>
          <div className="wcp-amount-text mt-[5px] text-[34px] font-bold tracking-[-1px]">
            {escrowCard.amount}
          </div>
          <div className="mt-[5px] text-[11px] leading-[1.4] text-faint">
            {released
              ? "Released to the seller — deal complete"
              : escrowCard.amountCaption}
          </div>
        </div>

        {/* Progress rail */}
        <ProgressRail steps={steps} released={released} />

        {/* CTA */}
        <button
          type="button"
          onClick={handleRelease}
          disabled={released}
          className="wcp-gradient wcp-gradient-hover-soft mt-[22px] w-full cursor-pointer rounded-[13px] py-[14px] text-center text-[14px] font-bold text-canvas transition-[filter] disabled:cursor-default"
        >
          {released ? "✓ Released" : escrowCard.cta}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ released }: { released: boolean }) {
  if (released) {
    return (
      <span
        className="flex items-center gap-[5px] rounded-[999px] px-2.5 py-[5px] text-[10px] font-bold text-lime transition-colors"
        style={{ background: "rgba(163,230,53,.14)" }}
      >
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-lime" />
        Released
      </span>
    );
  }
  return (
    <span
      className="flex items-center gap-[5px] rounded-[999px] px-2.5 py-[5px] text-[10px] font-bold text-brand-cyan transition-colors"
      style={{ background: "rgba(34,211,238,.12)" }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand-cyan" />
      Active
    </span>
  );
}

function ProgressRail({
  steps,
  released,
}: {
  steps: readonly Step[];
  released: boolean;
}) {
  return (
    <div className="relative mt-[22px]">
      {/* Base line */}
      <div className="absolute left-[31px] right-[31px] top-[13px] h-0.5 bg-line" />
      {/* Filled line — animates from node 2 to the end on release */}
      <div
        className="absolute left-[31px] top-[13px] h-0.5 transition-[width] duration-700 ease-out"
        style={{
          width: released ? "calc(100% - 62px)" : "78px",
          background: "linear-gradient(90deg,#7C5CFF,#22D3EE)",
        }}
      />
      <div className="relative flex justify-between">
        {steps.map((step) => (
          <div
            key={step.label}
            className="flex w-[62px] flex-col items-center gap-[7px]"
          >
            <StepNode step={step} />
            <div
              className={
                step.state === "active"
                  ? "text-[9.5px] font-bold text-ink"
                  : step.state === "done"
                    ? "text-[9.5px] font-semibold text-ink-secondary"
                    : "text-[9.5px] font-semibold text-faint"
              }
            >
              {step.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StepNode({ step }: { step: Step }) {
  if (step.state === "done") {
    return (
      <div className="wcp-gradient flex h-[26px] w-[26px] items-center justify-center rounded-full text-[12px] font-bold text-canvas transition-all">
        {step.glyph}
      </div>
    );
  }
  if (step.state === "active") {
    return (
      <div
        className="wcp-gradient flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] transition-all"
        style={{ boxShadow: "0 0 0 4px rgba(124,92,255,.22)" }}
      >
        {step.glyph}
      </div>
    );
  }
  return (
    <div className="flex h-[26px] w-[26px] items-center justify-center rounded-full border-2 border-line bg-panel text-[11px] font-bold text-faint transition-all">
      {step.glyph}
    </div>
  );
}
