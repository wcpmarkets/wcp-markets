"use client";

import { useId, useState } from "react";
import { track } from "@wcp/analytics";
import { faqs } from "@/lib/content";

/**
 * FAQ accordion (F-4): single-open, first item open by default. Each row is a
 * real <button> so Enter/Space and focus work natively; the answer is linked via
 * aria-controls. Firing `faq_expand` on open (F-7).
 */
export function FaqSection() {
  const [open, setOpen] = useState(0);
  const baseId = useId();

  return (
    <section id="faq" className="border-t border-divider bg-canvas-alt">
      <div className="mx-auto max-w-[760px] px-8 py-[72px]">
        <h2 className="text-center text-[34px] font-bold tracking-[-1px]">
          Questions, answered.
        </h2>

        <div className="mt-9 flex flex-col gap-3">
          {faqs.map((faq, i) => {
            const isOpen = open === i;
            const panelId = `${baseId}-panel-${i}`;
            const buttonId = `${baseId}-button-${i}`;
            return (
              <div
                key={faq.q}
                className="rounded-[14px] border border-line bg-panel transition-colors has-[button:hover]:border-line-hover"
              >
                <h3 className="m-0">
                  <button
                    id={buttonId}
                    type="button"
                    aria-expanded={isOpen}
                    aria-controls={panelId}
                    onClick={() => {
                      const next = isOpen ? -1 : i;
                      setOpen(next);
                      if (!isOpen) track("faq_expand", { index: i, question: faq.q });
                    }}
                    className="flex w-full cursor-pointer items-center gap-3 px-[22px] py-[18px] text-left"
                  >
                    <span className="flex-1 text-[15px] font-semibold text-ink">
                      {faq.q}
                    </span>
                    <span className="text-[14px] text-faint" aria-hidden="true">
                      {isOpen ? "−" : "+"}
                    </span>
                  </button>
                </h3>
                <div
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  hidden={!isOpen}
                  className="px-[22px] pb-[18px] text-[13.5px] leading-[1.7] text-muted"
                >
                  {faq.a}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
