import Link from "next/link";
import { adminApi, ago, naira, type DisputeQueueItem } from "@/lib/admin";
import { Chip, Empty, Failed, Person } from "../ui";

export const dynamic = "force-dynamic";

/** Open disputes, oldest first. DISPUTED = waiting on the seller (24h auto-refund clock). */
export default async function Disputes() {
  const r = await adminApi<DisputeQueueItem[]>("/admin/disputes");
  return (
    <section>
      <h1 className="text-xl font-bold">Disputes</h1>
      <p className="mt-1 text-sm text-muted">
        Oldest first. A dispute waiting on the seller refunds the buyer automatically after 24 hours; once the seller
        responds, it waits here for a decision.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        {!r.ok ? (
          <Failed error={r.error} />
        ) : r.data.length === 0 ? (
          <Empty>No open disputes.</Empty>
        ) : (
          r.data.map((d) => (
            <Link
              key={d.dealId}
              href={`/admin/disputes/${d.dealId}`}
              className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3 hover:border-line-hover"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{d.listingTitle ?? "(listing gone)"}</span>
                <span className="text-muted">{naira(d.principalKobo)}</span>
                {d.dealState === "DISPUTED_RESPONDED" ? (
                  <Chip tone="warn">Needs a decision</Chip>
                ) : (
                  <Chip>Waiting on seller</Chip>
                )}
                {d.buyerDisputes30d > 1 && <Chip tone="danger">Buyer: {d.buyerDisputes30d} disputes in 30d</Chip>}
                <span className="ml-auto text-xs text-faint">opened {ago(d.createdAt)}</span>
              </div>
              <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <Person u={d.buyer} role="Buyer" />
                <Person u={d.seller} role="Seller" />
              </div>
              {d.reason && <p className="line-clamp-2 text-sm text-ink-secondary">“{d.reason}”</p>}
            </Link>
          ))
        )}
      </div>
    </section>
  );
}
