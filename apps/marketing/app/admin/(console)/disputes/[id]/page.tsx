/* eslint-disable @next/next/no-img-element -- signed, short-lived storage URLs; next/image would cache them */
import Link from "next/link";
import { notFound } from "next/navigation";
import { adminApi, naira, when, who, type DisputeDetail } from "@/lib/admin";
import { DisputeDecision } from "../../forms";
import { Chip, Failed, Person } from "../../ui";

export const dynamic = "force-dynamic";

const OPEN = ["DISPUTED", "DISPUTED_RESPONDED"];

function Photos({ urls }: { urls: string[] }) {
  if (urls.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {urls.map((u) => (
        <a key={u} href={u} target="_blank" rel="noreferrer">
          <img src={u} alt="Evidence photo" className="h-24 w-24 rounded-lg border border-line object-cover" />
        </a>
      ))}
    </div>
  );
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">{title}</h2>
      {children}
    </section>
  );
}

export default async function DisputePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const r = await adminApi<DisputeDetail>(`/admin/disputes/${id}`);
  if (!r.ok) {
    if (r.status === 404) notFound();
    return <Failed error={r.error} />;
  }
  const { case: c, deal, listing, buyer, seller, events, messages } = r.data;
  const depositClaim = events.some((e) => e.action === "claim_deposit");
  const open = OPEN.includes(deal.state) && c?.status !== "resolved";
  const name = (sid: string) => (sid === buyer.id ? `${who(buyer)} (buyer)` : sid === seller.id ? `${who(seller)} (seller)` : "Someone else");

  return (
    <div className="flex flex-col gap-4">
      <Link href="/admin/disputes" className="text-sm text-muted hover:text-ink">← Disputes</Link>

      <header className="flex flex-wrap items-center gap-4">
        {listing?.imageUrl && <img src={listing.imageUrl} alt="" className="h-16 w-16 rounded-lg object-cover" />}
        <div className="min-w-0">
          <h1 className="text-xl font-bold">{listing?.title ?? "(listing gone)"}</h1>
          <p className="text-sm text-muted">
            {naira(deal.priceKobo)}
            {deal.qty > 1 && ` × ${deal.qty} = ${naira(deal.priceKobo * deal.qty)}`} · deal opened {when(deal.createdAt)} ·{" "}
            <span className="font-mono text-xs">{deal.id.slice(0, 8)}</span>
          </p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {depositClaim && <Chip tone="warn">Shortlet deposit claim</Chip>}
          <Chip tone={open ? "warn" : "muted"}>{deal.state.replaceAll("_", " ").toLowerCase()}</Chip>
        </div>
      </header>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <Person
          u={buyer}
          role="Buyer"
          extra={r.data.buyerDisputes30d > 1 && <Chip tone="danger">{r.data.buyerDisputes30d} disputes in 30d</Chip>}
        />
        <Person u={seller} role="Seller" />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={depositClaim ? "Guest" : "Buyer's complaint"}>
          {c ? (
            <>
              <p className="whitespace-pre-wrap">{c.reason}</p>
              {c.buyerEvidence && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-secondary">{c.buyerEvidence}</p>}
              <Photos urls={c.buyerPhotoUrls} />
              <p className="mt-2 text-xs text-faint">{when(c.createdAt)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">No case record — use the timeline and chat.</p>
          )}
        </Card>
        <Card title={depositClaim ? "Host's claim" : "Seller's response"}>
          {c?.sellerResponse ? (
            <>
              <p className="whitespace-pre-wrap">{c.sellerResponse}</p>
              {c.sellerEvidence && <p className="mt-2 whitespace-pre-wrap text-sm text-ink-secondary">{c.sellerEvidence}</p>}
              <Photos urls={c.sellerPhotoUrls} />
              <p className="mt-2 text-xs text-faint">{when(c.respondedAt)}</p>
            </>
          ) : (
            <p className="text-sm text-muted">
              No response yet. If the seller stays silent for 24 hours from the dispute, the buyer is refunded automatically.
            </p>
          )}
        </Card>
      </div>

      <Card title="Decision">
        {open ? (
          <DisputeDecision dealId={deal.id} depositClaim={depositClaim} />
        ) : c?.status === "resolved" ? (
          <p className="text-sm">
            {c.resolution === "release" ? "Released to the seller" : "Refunded to the buyer"} on {when(c.resolvedAt)}
            {c.resolutionNote && <span className="text-muted"> — “{c.resolutionNote}”</span>}
          </p>
        ) : (
          <p className="text-sm text-muted">No longer in dispute ({deal.state.toLowerCase()}).</p>
        )}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={`Chat (${messages.length})`}>
          {messages.length === 0 ? (
            <p className="text-sm text-muted">No messages.</p>
          ) : (
            <ol className="flex max-h-[32rem] flex-col gap-2 overflow-y-auto pr-1">
              {messages.map((m) => (
                <li key={m.id} className={`rounded-lg px-3 py-2 text-sm ${m.senderId === buyer.id ? "bg-canvas" : "bg-brand-purple/10"}`}>
                  <div className="mb-0.5 flex gap-2 text-xs text-faint">
                    <span>{name(m.senderId)}</span>
                    <span className="ml-auto">{when(m.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words">{m.body}</p>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="Timeline">
          <ol className="flex flex-col gap-1.5 text-sm">
            {events.map((e) => (
              <li key={e.seq} className="flex flex-wrap gap-x-2">
                <span className="w-28 shrink-0 text-xs text-faint">{when(e.createdAt)}</span>
                <span className="text-muted">{e.actor.toLowerCase()}</span>
                <span className="font-medium">{e.action.replaceAll("_", " ")}</span>
                {e.priceKobo != null && <span className="text-muted">{naira(e.priceKobo)}</span>}
                {e.reason && <span className="w-full pl-28 text-xs text-faint">{e.reason}</span>}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
  );
}
