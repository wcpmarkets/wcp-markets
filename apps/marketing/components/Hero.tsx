import { EscrowCard } from "./EscrowCard";
import { EmailCapture } from "./EmailCapture";
import { hero } from "@/lib/content";
import { flags } from "@/lib/flags";

/** Hero: promise headline + email capture on the left, escrow card on the right. */
export function Hero() {
  // Split the status pill so it can middle-truncate: the start truncates with an
  // ellipsis while the last word stays pinned, e.g. "Trust & Opp…soon".
  const pillWords = hero.statusPill.trim().split(" ");
  const pillEnd = pillWords.at(-1) ?? "";
  const pillStart = pillWords.slice(0, -1).join(" ");

  return (
    <header
      id="top"
      className="mx-auto flex max-w-[1140px] flex-wrap items-center gap-[60px] px-8 pb-20 pt-16"
    >
      {/* Left column */}
      <div className="min-w-[min(420px,100%)] flex-[1.2]">
        <div className="inline-flex max-w-full items-center gap-2 rounded-[999px] border border-line bg-panel px-[14px] py-[7px] text-[12px] text-muted">
          <span className="inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-lime" />
          <span className="flex min-w-0">
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
              {pillStart}
            </span>
            <span className="shrink-0 whitespace-nowrap">{` ${pillEnd}`}</span>
          </span>
        </div>

        <h1 className="mt-[22px] text-[40px] font-bold leading-[1.06] tracking-[-2px] min-[560px]:text-[58px]">
          {hero.headingLine1}
          <br />
          <span className="wcp-gradient-text">{hero.headingLine2}</span>
        </h1>

        <p className="mt-5 max-w-[520px] text-[17px] leading-[1.7] text-muted">
          {hero.sub}
        </p>

        {flags.waitlistOpen && (
          <div className="mt-[30px]">
            <EmailCapture source="hero" />
          </div>
        )}

        {/* Center the trust chips while the hero is stacked (single column);
            left-align once it becomes two columns (~864px). */}
        <div className="mt-[34px] flex flex-wrap justify-center gap-[22px] min-[864px]:justify-start">
          {hero.chips.map((chip) => (
            <div
              key={chip.label}
              className="flex items-center gap-2 text-[13px] text-ink-secondary"
            >
              <span className="text-brand-cyan">{chip.icon}</span>
              {chip.label}
            </div>
          ))}
        </div>
      </div>

      {/* Right column */}
      <div className="flex min-w-[min(320px,100%)] flex-1 justify-center">
        <EscrowCard />
      </div>
    </header>
  );
}
