import type { Sql } from "postgres";
import { searchWhere, type SearchParams } from "../routes/listings.js";
import { clip, deliver, money, type Note } from "./push.js";

/**
 * Saved & watches (0036, design 20k / 20l "Deals ✦"). 'listing.priced' is emitted when
 * a listing goes live or its price changes while live:
 *
 *   listing.priced { listingId, priceKobo, oldPriceKobo }   (old null = newly live)
 *
 *   1. A drop tells everyone who saved it (♡) — "Price drop: ₦155,000".
 *   2. Every watch it now satisfies gets a hit (once per watch + listing) and a push —
 *      "Watch caught one: PS5 Slim at ₦690,000". Matching is the search's own WHERE
 *      (searchWhere), so a watch finds exactly what searching would have.
 *
 * Both go out on the 'watch' topic, under the user's preferences like any push. Never
 * the seller's own listing.
 */
export const WATCH_TOPICS = new Set(["listing.priced"]);

type Priced = { listingId?: string; priceKobo?: number | string; oldPriceKobo?: number | string | null };
type ListingCtx = { id: string; seller_id: string; title: string; lane: string; category: string; status: string; price_kobo: string; city: string | null; state: string | null };
type WatchRow = { id: string; user_id: string; label: string; params: SearchParams; ceiling_kobo: string | null };

export async function handleListingPriced(db: Sql, msg: Priced): Promise<void> {
  if (!msg.listingId) return;
  const [l] = await db<ListingCtx[]>`
    select id, seller_id, title, lane, category, status, price_kobo::text as price_kobo, city, state
    from public.listings where id = ${msg.listingId}`;
  // Act on the listing as it is now: a later edit or a sale may have overtaken the poke.
  if (!l || l.status !== "active") return;
  const price = Number(l.price_kobo);
  if (msg.priceKobo != null && Number(msg.priceKobo) !== price) return; // superseded; its own event follows
  const old = msg.oldPriceKobo != null ? Number(msg.oldPriceKobo) : null;
  const title = clip(l.title, 60);
  const place = l.city ?? l.state ?? null;
  const data = { type: "listing", listingId: l.id };
  const notes: Note[] = [];

  // 1. Price drop → savers.
  if (old != null && price < old) {
    const savers = await db<{ user_id: string; at: string }[]>`
      select user_id, price_at_save_kobo::text as at from public.saved_listings
      where listing_id = ${l.id} and user_id <> ${l.seller_id}`;
    for (const s of savers) {
      const sinceSaved = Number(s.at) - price;
      notes.push({
        userId: s.user_id,
        topic: "watch",
        title: `Price drop: ${money(price)}`,
        body: sinceSaved > 0 ? `${title} — ↓ ${money(sinceSaved)} since you saved it` : `${title} — down from ${money(old)}`,
        key: `drop:${l.id}:${price}:${s.user_id}`,
        data,
        tag: `listing:${l.id}`,
      });
    }
  }

  // 2. Watches it now satisfies. Narrow by lane/category/ceiling in SQL, then run the
  // search's full WHERE against just this listing.
  const watches = await db<WatchRow[]>`
    select w.id, w.user_id, w.label, w.params, w.ceiling_kobo::text as ceiling_kobo
    from public.watches w
    where w.user_id <> ${l.seller_id}
      and (w.params->>'lane' is null or w.params->>'lane' = ${l.lane})
      and (w.params->>'category' is null or w.params->>'category' = ${l.category})
      and (w.ceiling_kobo is null or w.ceiling_kobo >= ${price})
      and not exists (select 1 from public.watch_hits h where h.watch_id = w.id and h.listing_id = ${l.id})`;
  for (const w of watches) {
    const [m] = await db`select 1 from public.listings where id = ${l.id} and ${searchWhere(db, w.params)}`;
    if (!m) continue;
    const [hit] = await db<{ id: string }[]>`
      insert into public.watch_hits (watch_id, listing_id, price_kobo, notified)
      values (${w.id}, ${l.id}, ${price}, true)
      on conflict (watch_id, listing_id) do nothing returning id`;
    if (!hit) continue;
    const under = w.ceiling_kobo != null ? Number(w.ceiling_kobo) - price : 0;
    notes.push({
      userId: w.user_id,
      topic: "watch",
      title: `Watch caught one: ${clip(l.title, 40)} at ${money(price)}`,
      body: [under > 0 ? `${money(under)} under your ceiling` : clip(w.label, 60), place].filter(Boolean).join(" · "),
      key: `watch:${w.id}:${l.id}`,
      data: { ...data, watchId: w.id },
      tag: `listing:${l.id}`,
    });
  }

  for (const n of notes) await deliver(db, n);
}
