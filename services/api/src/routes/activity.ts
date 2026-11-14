import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { LISTING_IMAGES_BUCKET, createSignedDownloadUrl } from "../supabase.js";

/**
 * Activity hub (design 22d) — everything the caller has in motion, across the four
 * lanes, in one list: deals (as buyer or seller, including shortlet bookings and
 * service jobs), live viewings, and quote requests nobody has quoted yet. Each item
 * names where a tap should go and, when it's the caller's move, the one action due.
 *
 * Settled or abandoned deals stay for 30 days so "Review" and "Refunded" are still
 * reachable; older ones live on in the deals list.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ActivityItemSchema = z
  .object({
    kind: z.enum(["deal", "viewing", "quote_request"]),
    id: z.string().uuid(),
    lane: z.enum(["goods", "property", "vehicles", "services"]),
    title: z.string(),
    imageUrl: z.string().nullable(),
    /** One line: amount, stage, when. */
    line: z.string(),
    /** The status chip, e.g. "In escrow", "Confirmed". */
    status: z.string(),
    /** The caller's move, if any — the chip becomes a filled button. */
    action: z.enum(["confirm", "pay", "respond", "hand_off", "review"]).nullable(),
    dealId: z.string().uuid().nullable(),
    conversationId: z.string().uuid().nullable(),
    listingId: z.string().uuid(),
    updatedAt: z.string(),
  })
  .openapi("ActivityItem");

type Lane = "goods" | "property" | "vehicles" | "services";
type Item = z.infer<typeof ActivityItemSchema>;

const naira = (k: number | string) => `₦${Math.round(Number(k) / 100).toLocaleString("en-NG")}`;
const iso = (d: string | Date) => (d instanceof Date ? d : new Date(d)).toISOString();
const LAGOS = "Africa/Lagos";
const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: LAGOS });
const when = (d: Date) =>
  `${d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", timeZone: LAGOS })}, ${d
    .toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: LAGOS })
    .replace(" ", "")}`;

const NEGOTIATING = ["OFFERED", "COUNTERED_BY_SELLER", "COUNTERED_BY_BUYER"];
const ENDED = ["DECLINED", "WITHDRAWN", "EXPIRED", "CANCELLED"];

type DealRow = {
  id: string; listing_id: string; buyer_id: string; seller_id: string; state: string; price_kobo: string;
  delivery_fee: string | null; terms: { booking?: { checkIn?: string; checkOut?: string }; service?: string } | null;
  updated_at: Date; lane: Lane; title: string; image: string | null; conversation_id: string | null; reviewed: boolean;
};

/** A deal as one activity line, from the caller's side. */
function dealItem(r: DealRow, me: string): Omit<Item, "imageUrl"> {
  const buyer = r.buyer_id === me;
  const total = naira(Number(r.price_kobo) + Number(r.delivery_fee ?? 0));
  const booking = !!r.terms?.booking;
  const service = !!r.terms?.service;
  const what = booking ? "Stay" : service ? "Quote" : "Deal";
  const awaiting = (r.state === "COUNTERED_BY_SELLER") === buyer;
  let line = "";
  let status = "";
  let action: Item["action"] = null;
  if (NEGOTIATING.includes(r.state)) {
    if (awaiting) { line = `${service ? "Quote" : "Offer"} ${naira(r.price_kobo)} · your move`; status = "Respond"; action = "respond"; }
    else { line = `${service ? "Quote" : "Offer"} ${naira(r.price_kobo)} · waiting on the ${buyer ? (service ? "provider" : "seller") : "buyer"}`; status = "Pending"; }
  } else switch (r.state) {
    case "ACCEPTED":
      if (buyer) { line = `${total} agreed · pay into escrow to lock it in`; status = "Pay"; action = "pay"; }
      else { line = `${total} agreed · waiting for payment`; status = "Accepted"; }
      break;
    case "PAYMENT_PENDING": line = `${total} · payment in progress`; status = "Paying"; break;
    case "PAID_IN_ESCROW":
      if (buyer) { line = `${total} in escrow · ${booking ? "stay booked" : service ? "job booked" : "awaiting hand-off"}`; status = booking || service ? "Scheduled" : "In escrow"; }
      else if (booking) { line = `${total} in escrow · guest booked`; status = "Booked"; }
      else { line = `${total} in escrow · ${service ? "do the job, then mark it done" : "hand it over"}`; status = service ? "Scheduled" : "Hand off"; action = service ? null : "hand_off"; }
      break;
    case "HANDED_OFF":
      if (buyer) { line = `${total} in escrow · ${booking ? "checked in" : "handed over"} ${day(r.updated_at)}`; status = "Confirm"; action = booking ? null : "confirm"; if (booking) status = "Staying"; }
      else { line = `Handed over ${day(r.updated_at)} · waiting for the buyer to confirm`; status = "Handed off"; }
      break;
    case "DISPUTED": case "DISPUTED_RESPONDED": line = `${total} held · in dispute`; status = "Dispute"; break;
    case "COMPLETED":
      line = `Completed ${day(r.updated_at)} · ${total}`;
      if (buyer && !r.reviewed && !booking) { status = "Review"; action = "review"; } else status = "Done";
      break;
    case "REFUNDED": line = `Refunded ${day(r.updated_at)} · ${total}`; status = "Refunded"; break;
    default:
      if (ENDED.includes(r.state)) { line = `${what} ${r.state.toLowerCase()} ${day(r.updated_at)}`; status = "Closed"; }
      else { line = `${what} · ${r.state.toLowerCase().replace(/_/g, " ")}`; status = r.state; }
  }
  return {
    kind: "deal", id: r.id, lane: r.lane, title: r.title, line, status, action,
    dealId: r.id, conversationId: r.conversation_id, listingId: r.listing_id, updatedAt: iso(r.updated_at),
  };
}

export function registerActivity(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/activity",
      summary: "Everything in motion across the lanes: deals, viewings, quote requests (22d)",
      tags: ["activity"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Items, the caller's moves first, then newest", content: { "application/json": { schema: z.array(ActivityItemSchema) } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const me = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);

      const [deals, viewings, quotes] = await Promise.all([
        db<DealRow[]>`
          select d.id, d.listing_id, d.buyer_id, d.seller_id, d.state, d.price_kobo::text as price_kobo,
                 (d.delivery->>'feeKobo') as delivery_fee, d.terms, d.updated_at,
                 l.lane, l.title, l.image_paths[1] as image,
                 (select c.id from public.conversations c where c.listing_id = d.listing_id and c.buyer_id = d.buyer_id) as conversation_id,
                 exists (select 1 from public.reviews r where r.deal_id = d.id) as reviewed
          from public.deals d join public.listings l on l.id = d.listing_id
          where (d.buyer_id = ${me} or d.seller_id = ${me})
            and (d.state not in ('COMPLETED', 'REFUNDED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'CANCELLED')
                 or d.updated_at > now() - interval '30 days')
          order by d.updated_at desc limit 100`,
        db<{ id: string; conversation_id: string; listing_id: string; proposed_by: string; starts_at: Date; place: string; status: string; updated_at: Date; lane: Lane; title: string; image: string | null; other: string | null }[]>`
          select v.id, v.conversation_id, c.listing_id, v.proposed_by, v.starts_at, v.place, v.status, v.updated_at,
                 l.lane, l.title, l.image_paths[1] as image,
                 coalesce(p.store_name, p.display_name) as other
          from public.viewings v
          join public.conversations c on c.id = v.conversation_id
          join public.listings l on l.id = c.listing_id
          left join public.profiles p on p.id = case when c.buyer_id = ${me} then c.seller_id else c.buyer_id end
          where (c.buyer_id = ${me} or c.seller_id = ${me})
            and v.status in ('proposed', 'confirmed') and coalesce(v.ends_at, v.starts_at) > now() - interval '1 day'
          order by v.starts_at limit 50`,
        db<{ id: string; conversation_id: string; listing_id: string; buyer_id: string; service: string; created_at: Date; lane: Lane; title: string; image: string | null; other: string | null }[]>`
          select q.id, q.conversation_id, q.listing_id, q.buyer_id, q.service, q.created_at,
                 l.lane, l.title, l.image_paths[1] as image,
                 coalesce(p.store_name, p.display_name) as other
          from public.quote_requests q
          join public.listings l on l.id = q.listing_id
          left join public.profiles p on p.id = case when q.buyer_id = ${me} then q.seller_id else q.buyer_id end
          where (q.buyer_id = ${me} or q.seller_id = ${me}) and q.status = 'open' and q.deal_id is null
          order by q.created_at desc limit 50`,
      ]);

      const items: (Omit<Item, "imageUrl"> & { image: string | null })[] = [
        ...deals.map((r) => ({ ...dealItem(r, me), image: r.image })),
        ...viewings.map((v) => {
          const mine = v.proposed_by === me;
          const confirmed = v.status === "confirmed";
          return {
            kind: "viewing" as const, id: v.id, lane: v.lane, title: v.title, image: v.image,
            line: `Viewing ${when(new Date(v.starts_at))} · ${v.place}${v.other ? ` · ${v.other}` : ""}`,
            status: confirmed ? "Confirmed" : mine ? "Proposed" : "Respond",
            action: !confirmed && !mine ? ("respond" as const) : null,
            dealId: null, conversationId: v.conversation_id, listingId: v.listing_id, updatedAt: iso(v.updated_at),
          };
        }),
        ...quotes.map((q) => {
          const buyer = q.buyer_id === me;
          return {
            kind: "quote_request" as const, id: q.id, lane: q.lane, title: buyer ? (q.other ?? q.title) : q.title, image: q.image,
            line: buyer ? `Quote requested · ${q.service}` : `${q.other ?? "A buyer"} wants a quote · ${q.service}`,
            status: buyer ? "Requested" : "Quote",
            action: buyer ? null : ("respond" as const),
            dealId: null, conversationId: q.conversation_id, listingId: q.listing_id, updatedAt: iso(q.created_at),
          };
        }),
      ];
      // The caller's moves first, then newest.
      items.sort((a, b) => Number(!!b.action) - Number(!!a.action) || b.updatedAt.localeCompare(a.updatedAt));

      const urls = new Map<string, string | null>();
      await Promise.all(
        [...new Set(items.map((i) => i.image).filter((p): p is string => !!p))].map(async (p) =>
          urls.set(p, await createSignedDownloadUrl(LISTING_IMAGES_BUCKET, p).catch(() => null)),
        ),
      );
      return c.json(items.map(({ image, ...i }) => ({ ...i, imageUrl: image ? urls.get(image) ?? null : null })), 200);
    },
  );
}
