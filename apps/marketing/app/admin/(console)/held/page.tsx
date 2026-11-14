import { adminApi, ago, naira, type HeldListing } from "@/lib/admin";
import { ListingReview } from "../forms";
import { Chip, Empty, Failed, Person } from "../ui";

export const dynamic = "force-dynamic";

const FLAG: Record<string, string> = {
  contact_details: "Contact details",
  off_platform_payment: "Pay outside escrow",
  price_far_below: "Price far below",
};

/**
 * Listings publish-time screening held (design 13d-flagged), oldest first. Nothing is
 * declined automatically: approve puts it on sale, reject removes it and the reason
 * goes to the seller. A seller who fixes the listing clears the hold themselves, so
 * what's here is what they submitted as-is.
 */
export default async function Held() {
  const r = await adminApi<HeldListing[]>("/admin/listings/held?limit=100");
  return (
    <section>
      <h1 className="text-xl font-bold">Held listings</h1>
      <p className="mt-1 text-sm text-muted">
        Caught by the publish-time checks. Approve if it&apos;s fine; reject with a reason the seller will read.
      </p>
      <div className="mt-5 flex flex-col gap-2">
        {!r.ok ? (
          <Failed error={r.error} />
        ) : r.data.length === 0 ? (
          <Empty>Nothing held.</Empty>
        ) : (
          r.data.map((x) => (
            <article key={x.id} className="flex flex-col gap-2 rounded-xl border border-line bg-panel px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                {x.flags.map((f) => (
                  <Chip key={f.code} tone={f.code === "off_platform_payment" ? "danger" : "warn"}>{FLAG[f.code] ?? f.code}</Chip>
                ))}
                <span className="text-sm text-muted">{x.lane} · {x.category}</span>
                <span className="ml-auto text-xs text-faint">{ago(x.createdAt)}</span>
              </div>
              <div className="text-sm">
                <Person u={x.seller} role="Seller" />
              </div>
              <p className="text-sm">
                <span className="font-medium">{x.title}</span> · {naira(x.priceKobo)}
                {x.city || x.state ? <span className="text-muted"> · {[x.city, x.state].filter(Boolean).join(", ")}</span> : null}
              </p>
              {x.imageUrls.length > 0 && (
                <div className="flex gap-2">
                  {x.imageUrls.map((u) => (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img key={u} src={u} alt="" className="h-20 w-20 rounded-lg object-cover" />
                  ))}
                </div>
              )}
              {x.description && (
                <blockquote className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas px-3 py-2 text-sm">
                  {x.description}
                </blockquote>
              )}
              <ul className="list-disc pl-5 text-sm text-ink-secondary">
                {x.flags.map((f) => <li key={f.code}>{f.detail}</li>)}
              </ul>
              <ListingReview listingId={x.id} />
            </article>
          ))
        )}
      </div>
    </section>
  );
}
