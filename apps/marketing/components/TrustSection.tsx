import { Eyebrow } from "@wcp/ui";
import { trust } from "@/lib/content";

/** "Built-in trust" — four proof cards answering "is this a scam?". */
export function TrustSection() {
  return (
    <section className="border-t border-divider">
      <div className="mx-auto max-w-[1140px] px-8 py-[72px]">
        <Eyebrow>BUILT-IN TRUST</Eyebrow>
        <h2 className="mt-3 text-[34px] font-bold tracking-[-1px]">
          &quot;Is this a scam?&quot; — solved.
        </h2>

        <div className="mt-9 grid gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(250px,1fr))]">
          {trust.map((card) => (
            <div
              key={card.title}
              className="rounded-[16px] border border-line bg-panel p-[22px]"
            >
              <div className="text-[20px]">{card.icon}</div>
              <div className="mt-2.5 text-[15px] font-bold">{card.title}</div>
              <div className="mt-1.5 text-[13px] leading-[1.6] text-muted">
                {card.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
