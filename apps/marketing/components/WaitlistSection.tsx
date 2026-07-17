"use client";

import { EmailCapture } from "./EmailCapture";
import { useWaitlist } from "./WaitlistProvider";
import { waitlistSection, waitlistNotes } from "@/lib/content";

/** Final conversion ask. Shows the capture form, or an inline success chip once joined. */
export function WaitlistSection() {
  const { joined } = useWaitlist();

  return (
    <section id="waitlist" className="border-t border-divider">
      <div className="mx-auto max-w-[1140px] px-8 py-20 text-center">
        <h2 className="text-[40px] font-bold tracking-[-1.4px]">
          {waitlistSection.heading}
        </h2>
        <p className="mx-auto mt-3.5 max-w-[480px] text-[15px] leading-[1.7] text-muted">
          {waitlistSection.sub}
        </p>

        {joined ? (
          <div className="mt-7 inline-flex items-center gap-2.5 rounded-[14px] border border-brand-cyan bg-panel px-[26px] py-4 text-[14.5px] text-ink">
            <span className="text-[16px] text-brand-cyan">✓</span>
            {waitlistNotes.successChip}
          </div>
        ) : (
          <div className="mt-7">
            <EmailCapture source="waitlist" align="center" />
          </div>
        )}

        <div className="mt-3.5 text-[12px] text-faint">
          {waitlistSection.finePrint}
        </div>
      </div>
    </section>
  );
}
