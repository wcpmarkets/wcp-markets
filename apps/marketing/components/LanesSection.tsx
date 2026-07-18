import { Eyebrow } from "@wcp/ui";
import { lanes } from "@/lib/content";

/** "One app · four lanes" — a responsive card grid, hover border → lane accent. */
export function LanesSection() {
  return (
    <section id="lanes" className="border-t border-divider bg-canvas-alt">
      <div className="mx-auto max-w-[1140px] px-8 py-[72px]">
        <Eyebrow>ONE APP · FOUR LANES</Eyebrow>
        <h2 className="mt-3 text-[34px] font-bold tracking-[-1px]">
          Everything in one marketplace.
          <br />
          With the deal closed safely in-app.
        </h2>

        <div className="mt-9 grid gap-[14px] [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
          {lanes.map((lane) => (
            <div
              key={lane.tag}
              className="rounded-[18px] border border-line bg-panel p-6 transition-colors hover:[border-color:var(--accent)]"
              style={{ ["--accent" as string]: lane.accent }}
            >
              <span
                className="rounded-[999px] px-[9px] py-[3px] text-[9.5px] font-bold"
                style={{ background: lane.tagBg, color: lane.accent }}
              >
                {lane.tag}
              </span>
              <div className="mt-[14px] text-[17px] font-bold">{lane.title}</div>
              <div className="mt-2 text-[13px] leading-[1.65] text-muted">
                {lane.body}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
