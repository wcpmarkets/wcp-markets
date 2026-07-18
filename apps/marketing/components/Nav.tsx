"use client";

import { useState } from "react";
import Image from "next/image";
import { GradientButton } from "@wcp/ui";
import { track } from "@wcp/analytics";
import { nav } from "@/lib/content";

/**
 * Top navigation. Anchor links smooth-scroll (F-6).
 *
 * Desktop (≥720px): logo + inline links + waitlist CTA pill.
 * Mobile (<720px): logo + hamburger only — the links and the waitlist CTA live
 * in the dropdown. Keeping just two items on the mobile bar guarantees the
 * "WCP Markets" wordmark never wraps and the menu icon never gets squeezed,
 * even at 320px.
 */
export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="relative mx-auto flex max-w-[1140px] items-center gap-4 px-8 py-[22px]">
      <a
        href="#top"
        onClick={() => setOpen(false)}
        className="flex shrink-0 items-center gap-2"
        aria-label="WCP Markets — home"
      >
        <Image
          src="/wcp-logomark.png"
          alt=""
          width={1306}
          height={1439}
          className="h-7 w-auto shrink-0 object-contain"
          priority
        />
        <span className="whitespace-nowrap text-[18px] font-bold tracking-[-0.3px] text-ink">
          WCP Markets
        </span>
      </a>

      <div className="flex-1" />

      {/* Desktop links + CTA */}
      <div className="hidden items-center gap-[26px] text-[13.5px] min-[720px]:flex">
        {nav.links.map((link) => (
          <a
            key={link.href}
            href={link.href}
            className="whitespace-nowrap text-ink-secondary hover:text-ink"
          >
            {link.label}
          </a>
        ))}
        <GradientButton
          href={nav.cta.href}
          size="pill"
          className="shrink-0"
          onClick={() => track("cta_click", { location: "nav" })}
        >
          {nav.cta.label}
        </GradientButton>
      </div>

      {/* Mobile: hamburger only */}
      <button
        type="button"
        aria-label={open ? "Close menu" : "Open menu"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border border-line text-ink min-[720px]:hidden"
      >
        <span className="text-[16px] leading-none">{open ? "✕" : "☰"}</span>
      </button>

      {/* Mobile dropdown */}
      {open && (
        <div className="absolute inset-x-0 top-full z-20 border-t border-line bg-canvas min-[720px]:hidden">
          <div className="mx-auto flex max-w-[1140px] flex-col gap-1 px-8 py-4">
            {nav.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className="rounded-lg px-2 py-3 text-[15px] text-ink-secondary hover:bg-panel hover:text-ink"
              >
                {link.label}
              </a>
            ))}
            <GradientButton
              href={nav.cta.href}
              size="lg"
              className="mt-2 w-full"
              onClick={() => {
                track("cta_click", { location: "nav_mobile" });
                setOpen(false);
              }}
            >
              {nav.cta.label}
            </GradientButton>
          </div>
        </div>
      )}
    </nav>
  );
}
