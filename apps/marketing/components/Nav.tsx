"use client";

import { useState } from "react";
import Image from "next/image";
import { GradientButton, cn } from "@wcp/ui";
import { track } from "@wcp/analytics";
import { nav } from "@/lib/content";

/**
 * Top navigation. Anchor links smooth-scroll (F-6). Below ~720px the link row
 * collapses into a toggle menu; the waitlist CTA stays visible at all widths.
 */
export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="relative mx-auto flex max-w-[1140px] items-center gap-7 px-8 py-[22px]">
      <a href="#top" className="flex items-center gap-[3px]" aria-label="WCP Markets — home">
        <Image
          src="/wcp-logo.png"
          alt=""
          width={30}
          height={30}
          className="h-[30px] w-[30px] shrink-0 object-contain"
          priority
        />
        <span className="text-[18px] font-bold tracking-[-0.3px] text-ink">
          WCP Markets
        </span>
      </a>

      <div className="flex-1" />

      {/* Desktop links */}
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

      {/* Mobile: CTA + menu toggle */}
      <div className="flex items-center gap-3 min-[720px]:hidden">
        <GradientButton
          href={nav.cta.href}
          size="pill"
          className="shrink-0"
          onClick={() => track("cta_click", { location: "nav" })}
        >
          {nav.cta.label}
        </GradientButton>
        <button
          type="button"
          aria-label="Toggle menu"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-line text-ink"
        >
          <span className="text-[16px] leading-none">{open ? "✕" : "☰"}</span>
        </button>
      </div>

      {/* Mobile dropdown */}
      {open && (
        <div className="absolute inset-x-0 top-full z-20 border-t border-line bg-canvas min-[720px]:hidden">
          <div className="mx-auto flex max-w-[1140px] flex-col gap-1 px-8 py-3">
            {nav.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                onClick={() => setOpen(false)}
                className={cn(
                  "rounded-lg px-2 py-3 text-[15px] text-ink-secondary hover:bg-panel hover:text-ink",
                )}
              >
                {link.label}
              </a>
            ))}
          </div>
        </div>
      )}
    </nav>
  );
}
