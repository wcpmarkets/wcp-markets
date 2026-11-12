import { adminApi, ago, when, type AdminRecovery } from "@/lib/admin";
import { RecoveryDecision } from "../forms";
import { Chip, Empty, Failed } from "../ui";

export const dynamic = "force-dynamic";

/**
 * Account recoveries the automatic checks couldn't settle (no last order or email to
 * ask about, or a seller with no stored ID). Approving starts the 24-hour hold: both
 * numbers get an SMS and the owner can still cancel from the app.
 */
export default async function Recoveries() {
  const [review, holding] = await Promise.all([
    adminApi<AdminRecovery[]>("/admin/recoveries?status=review"),
    adminApi<AdminRecovery[]>("/admin/recoveries?status=holding"),
  ]);
  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="text-xl font-bold">Account recoveries</h1>
        <p className="mt-1 text-sm text-muted">
          These people lost their number and the app had nothing it could check automatically. Approve only once
          they&apos;ve proved to support that the account is theirs — for example, details of a past deal or ID
          matching a verified seller. The owner can still cancel during the 24-hour hold.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {!review.ok ? (
            <Failed error={review.error} />
          ) : review.data.length === 0 ? (
            <Empty>Nothing waiting for review.</Empty>
          ) : (
            review.data.map((x) => (
              <article key={x.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{x.accountName ?? "Unnamed account"}</span>
                  <Chip tone={x.branch === "seller" ? "warn" : "muted"}>{x.branch === "seller" ? "Verified seller" : "Basic account"}</Chip>
                  <span className="ml-auto text-xs text-faint">requested {ago(x.createdAt)}</span>
                </div>
                <p className="text-sm text-muted">
                  Lost <span className="font-mono text-ink">{x.lostPhone}</span> → new{" "}
                  <span className="font-mono text-ink">{x.newPhone}</span> · {x.attempts} failed answer{x.attempts === 1 ? "" : "s"}
                </p>
                <p className="font-mono text-xs text-faint">ref {x.id.slice(0, 8)}</p>
                <RecoveryDecision recoveryId={x.id} />
              </article>
            ))
          )}
        </div>
      </div>

      <div>
        <h2 className="font-semibold">On hold</h2>
        <div className="mt-3 flex flex-col gap-2">
          {!holding.ok ? (
            <Failed error={holding.error} />
          ) : holding.data.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            holding.data.map((x) => (
              <div key={x.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-4 py-3 text-sm">
                <span className="font-medium">{x.accountName ?? "Unnamed account"}</span>
                <span className="text-muted">
                  {x.lostPhone} → {x.newPhone}
                </span>
                <span className="ml-auto text-xs text-faint">completes {when(x.holdUntil)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </section>
  );
}
