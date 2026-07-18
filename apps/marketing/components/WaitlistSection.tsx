import { EmailCapture } from "./EmailCapture";
import { waitlistSection } from "@/lib/content";

/**
 * Final conversion ask. EmailCapture shows the form, or (once joined) the shared
 * success chip — same behavior as the hero.
 */
export function WaitlistSection() {
  return (
    <section id="waitlist" className="border-t border-divider">
      <div className="mx-auto max-w-[1140px] px-8 py-20 text-center">
        <h2 className="text-[40px] font-bold tracking-[-1.4px]">
          {waitlistSection.heading}
        </h2>
        <p className="mx-auto mt-3.5 max-w-[480px] text-[15px] leading-[1.7] text-muted">
          {waitlistSection.sub}
        </p>

        <div className="mt-7">
          <EmailCapture source="waitlist" align="center" />
        </div>

        <div className="mt-3.5 text-[12px] text-faint">
          {waitlistSection.finePrint}
        </div>
      </div>
    </section>
  );
}
