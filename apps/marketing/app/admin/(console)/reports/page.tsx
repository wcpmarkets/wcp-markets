import { adminApi, ago, type ReportQueueItem } from "@/lib/admin";
import { ReportDecision } from "../forms";
import { Chip, Empty, Failed, Person } from "../ui";

export const dynamic = "force-dynamic";

const REASON: Record<string, string> = {
  scam: "Scam",
  counterfeit: "Counterfeit",
  prohibited: "Prohibited item",
  misleading: "Misleading",
  offensive: "Offensive",
  harassment: "Harassment",
  other: "Other",
};

/**
 * Open reports, oldest first. One decision closes every open report on the same
 * target. Dismiss puts a paused listing back on sale; Remove takes it down for good;
 * Uphold records a violation by a person or in a message (action taken outside).
 */
export default async function Reports() {
  const r = await adminApi<ReportQueueItem[]>("/admin/reports?limit=100");
  return (
    <section>
      <h1 className="text-xl font-bold">Reports</h1>
      <p className="mt-1 text-sm text-muted">
        Oldest first. Deciding one closes every open report on the same listing, person or message. Reporters stay
        anonymous to the person reported.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        {!r.ok ? (
          <Failed error={r.error} />
        ) : r.data.length === 0 ? (
          <Empty>No open reports.</Empty>
        ) : (
          r.data.map((x) => (
            <article key={x.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Chip tone={x.reason === "scam" ? "danger" : "muted"}>{REASON[x.reason] ?? x.reason}</Chip>
                <span className="text-sm text-muted">{x.targetType}</span>
                {x.pausedListing && <Chip tone="warn">Listing paused</Chip>}
                {x.openReportsOnTarget > 1 && <Chip>{x.openReportsOnTarget} open reports on this</Chip>}
                {x.reportsAgainstUser30d > 1 && <Chip tone="danger">{x.reportsAgainstUser30d} reports vs this person in 30d</Chip>}
                <span className="ml-auto text-xs text-faint">{ago(x.createdAt)}</span>
              </div>
              <div className="text-sm">
                <Person u={x.reportedUser} role="Reported" />
              </div>
              {x.listing && (
                <p className="text-sm">
                  Listing: <span className="font-medium">{x.listing.title}</span>{" "}
                  <span className="text-muted">({x.listing.status.replace("_", " ")})</span>
                </p>
              )}
              {x.message && (
                <blockquote className="whitespace-pre-wrap break-words rounded-lg bg-canvas px-3 py-2 text-sm">{x.message.body}</blockquote>
              )}
              {x.details && <p className="whitespace-pre-wrap text-sm text-ink-secondary">Reporter: “{x.details}”</p>}
              <ReportDecision reportId={x.id} canRemoveListing={x.targetType !== "user"} />
            </article>
          ))
        )}
      </div>
    </section>
  );
}
