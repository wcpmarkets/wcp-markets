import { Eyebrow, cn } from "@wcp/ui";
import { escrowSteps } from "@/lib/content";

/** "How escrow works" — copy on the left, four numbered step cards on the right. */
export function EscrowSection() {
  return (
    <section id="escrow" className="border-t border-divider">
      <div className="mx-auto max-w-[1140px] px-8 py-[72px]">
        <div className="flex flex-wrap items-start gap-[60px]">
          <div className="min-w-[min(340px,100%)] flex-1">
            <Eyebrow>THE TRUST ENGINE</Eyebrow>
            <h2 className="mt-3 text-[34px] font-bold tracking-[-1px]">
              Your money never touches the seller until you say so.
            </h2>
            <p className="mt-4 text-[15px] leading-[1.7] text-muted">
              The biggest problem with buying online in Nigeria isn&apos;t finding
              the thing — it&apos;s paying a stranger and praying. WCP Markets holds
              the money in the middle.
            </p>
          </div>

          <div className="flex min-w-[min(340px,100%)] flex-1 flex-col gap-3">
            {escrowSteps.map((step) => (
              <div
                key={step.n}
                className={cn(
                  "flex gap-4 rounded-[16px] border bg-panel px-5 py-[18px]",
                  step.emphasis ? "border-brand-cyan" : "border-line",
                )}
              >
                <span className="wcp-gradient flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full text-[13px] font-bold text-canvas">
                  {step.n}
                </span>
                <div>
                  <div className="text-[15px] font-bold">{step.title}</div>
                  <div className="mt-[3px] text-[13px] leading-[1.6] text-muted">
                    {step.body}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
