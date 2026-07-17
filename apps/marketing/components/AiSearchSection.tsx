import { Eyebrow, cn } from "@wcp/ui";
import { aiSearch } from "@/lib/content";

/** "AI-native search" — pitch + bullets on the left, a chat mock on the right. */
export function AiSearchSection() {
  return (
    <section id="ai" className="border-t border-divider bg-canvas-alt">
      <div className="mx-auto flex max-w-[1140px] flex-wrap items-center gap-[60px] px-8 py-[72px]">
        <div className="min-w-[min(340px,100%)] flex-1">
          <Eyebrow>AI-NATIVE SEARCH</Eyebrow>
          <h2 className="mt-3 text-[34px] font-bold tracking-[-1px]">
            {aiSearch.heading}
          </h2>
          <p className="mt-4 text-[15px] leading-[1.7] text-muted">
            {aiSearch.body}
          </p>
          <div className="mt-[22px] flex flex-col gap-2.5">
            {aiSearch.bullets.map((b) => (
              <div
                key={b}
                className="flex items-center gap-2.5 text-[13.5px] text-ink-secondary"
              >
                <span className="text-brand-cyan">✦</span>
                {b}
              </div>
            ))}
          </div>
        </div>

        {/* Chat mock */}
        <div className="min-w-[min(340px,100%)] flex-1">
          <div className="mx-auto max-w-[460px] rounded-[20px] border border-line bg-panel p-[22px]">
            {/* User bubble */}
            <div className="ml-[60px] self-end rounded-[14px_14px_4px_14px] bg-[#1D2330] px-4 py-3 text-[13.5px] text-ink">
              {aiSearch.userMessage}
            </div>

            {/* AI reply (gradient border wrapper) */}
            <div className="wcp-gradient mr-10 mt-3 rounded-[14px_14px_14px_4px] p-[1.5px]">
              <div className="rounded-[12.5px] bg-panel px-4 py-[13px] text-[13px] leading-[1.6] text-ink-secondary">
                <span className="text-brand-cyan">✦</span> Found{" "}
                <b className="text-ink">31 homes for rent</b> in Lekki ≤ ₦4m/yr with
                2 beds — 12 are serviced, from verified agents. Want me to sort by
                newest?
              </div>
            </div>

            {/* Filter chips */}
            <div className="mt-[14px] flex flex-wrap gap-[7px]">
              {aiSearch.filters.map((chip) => (
                <span
                  key={chip.label}
                  className={cn(
                    "rounded-[999px] px-3 py-1.5 text-[11px]",
                    chip.dashed
                      ? "border border-dashed border-line-hover text-muted"
                      : "bg-line text-ink-secondary",
                  )}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
