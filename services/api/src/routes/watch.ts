import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "../db.js";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { LANES, LISTING_SELECT, ListingSchema, searchWhere, toListings, type ListingRow, type SearchParams } from "./listings.js";
import { SearchFiltersSchema } from "./search.js";

/**
 * Saved & watches (0036) — design 20k, and 21a's "Watch this search for me".
 *
 *   ♡ saved listings live on the server now, each remembering the price when saved
 *   ("↓ ₦15k since saved"); a price drop pushes to whoever saved it.
 *   A watch is a search kept running: the AI reading's lane + keywords + filters, with
 *   a price ceiling. New and re-priced listings are matched in the consumer
 *   (notify/watch.ts) with the search's own WHERE. What already matches when the watch
 *   is made is shown, not pushed.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const MAX_WATCHES = 20;
const MAX_SAVED = 300;

const SavedItemSchema = z
  .object({
    listing: ListingSchema,
    priceAtSaveKobo: z.number().int(),
    /** Price now minus price when saved: negative = cheaper. */
    changeKobo: z.number().int(),
    savedAt: z.string(),
  })
  .openapi("SavedItem");
const SavedPageSchema = z.object({ items: z.array(SavedItemSchema) }).openapi("SavedPage");
const SavedIdsSchema = z.object({ ids: z.array(z.string().uuid()) }).openapi("SavedIds");
const SavedStateSchema = z.object({ saved: z.boolean() }).openapi("SavedState");

const WatchHitSchema = z
  .object({
    listing: ListingSchema,
    /** The price it matched at. */
    priceKobo: z.number().int(),
    /** How far under the ceiling, when there is one. */
    underKobo: z.number().int().nullable(),
    createdAt: z.string(),
  })
  .openapi("WatchHit");
const WatchSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    ceilingKobo: z.number().int().nullable(),
    /** Switched off (20k toggle): keeps its hits, catches nothing new. */
    paused: z.boolean(),
    createdAt: z.string(),
    /** Live matches not dismissed, newest first (20k "TRIGGERED"). */
    hits: z.array(WatchHitSchema),
    /** What's on the market for this search ignoring the ceiling — "market min ₦850k". */
    marketCount: z.number().int(),
    marketMinKobo: z.number().int().nullable(),
  })
  .openapi("Watch");
const WatchListSchema = z.object({ items: z.array(WatchSchema) }).openapi("WatchList");
const WatchCreateSchema = z
  .object({
    /** As shown back: "iPhone 14 Pro under ₦400k · Yaba". */
    label: z.string().trim().min(1).max(160),
    lane: z.enum(LANES).optional(),
    keywords: z.string().trim().max(120).optional(),
    filters: SearchFiltersSchema,
    /** Where they were browsing, when the reading names no place. */
    state: z.string().max(64).optional(),
    city: z.string().max(64).optional(),
    /** Ping when something lands at or under this (defaults to filters.maxPrice). */
    ceilingKobo: z.number().int().positive().optional(),
  })
  .openapi("WatchCreate");
const WatchUpdateSchema = z.object({ paused: z.boolean() }).openapi("WatchUpdate");
const DismissSchema = z.object({ listingId: z.string().uuid() }).openapi("WatchDismiss");

/** LISTING_SELECT with each column qualified by the listings alias `l`. */
const L_COLS = LISTING_SELECT.split(",").map((c) => `l.${c.trim()}`).join(", ");

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const iso = (v: string | Date) => (typeof v === "string" ? v : v.toISOString());
const strip = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as T;

/** One watch in the API's shape: its open hits and the market for its search. */
async function watchOut(
  db: Db,
  w: { id: string; label: string; params: SearchParams; ceiling_kobo: string | null; paused: boolean; created_at: Date | string },
): Promise<z.infer<typeof WatchSchema>> {
  const hits = await db<(ListingRow & { hit_price: string; hit_at: Date })[]>`
    select ${db.unsafe(L_COLS)},
           h.price_kobo::text as hit_price, h.created_at as hit_at
    from public.watch_hits h join public.listings l on l.id = h.listing_id
    where h.watch_id = ${w.id} and h.dismissed_at is null and l.status = 'active'
    order by h.created_at desc limit 5`;
  const listings = await toListings(db, hits);
  const ceiling = w.ceiling_kobo != null ? Number(w.ceiling_kobo) : null;
  const { maxPrice: _ceil, ...market } = w.params;
  const [m] = await db<{ n: number; lo: string | null }[]>`
    select count(*)::int as n, min(price_kobo)::text as lo from public.listings where ${searchWhere(db, market)}`;
  return {
    id: w.id,
    label: w.label,
    ceilingKobo: ceiling,
    paused: w.paused,
    createdAt: iso(w.created_at),
    hits: hits.map((h, i) => ({
      listing: listings[i]!,
      priceKobo: Number(h.hit_price),
      underKobo: ceiling != null ? ceiling - Number(h.hit_price) : null,
      createdAt: iso(h.hit_at),
    })),
    marketCount: m?.n ?? 0,
    marketMinKobo: m?.lo != null ? Number(m.lo) : null,
  };
}

export function registerWatch(app: OpenAPIHono<AuthEnv>) {
  const err = (d: string) => ({ description: d, content: { "application/json": { schema: ErrorSchema } } });

  // ── Saved (♡) ────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/saved",
      summary: "My saved listings, newest first, with the price change since saving",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: { 200: { description: "Saved", content: { "application/json": { schema: SavedPageSchema } } }, 401: { description: "Unauthorized" }, 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<(ListingRow & { at: string; saved_at: Date })[]>`
        select ${db.unsafe(L_COLS)}, s.price_at_save_kobo::text as at, s.created_at as saved_at
        from public.saved_listings s join public.listings l on l.id = s.listing_id
        where s.user_id = ${c.get("user").sub} and l.status <> 'draft'
        order by s.created_at desc limit ${MAX_SAVED}`;
      const listings = await toListings(db, rows);
      return c.json(
        {
          items: rows.map((r, i) => ({
            listing: listings[i]!,
            priceAtSaveKobo: Number(r.at),
            changeKobo: Number(r.price_kobo) - Number(r.at),
            savedAt: iso(r.saved_at),
          })),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/saved/ids",
      summary: "Just the ids I've saved (for the ♡ on cards)",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: { 200: { description: "Ids", content: { "application/json": { schema: SavedIdsSchema } } }, 401: { description: "Unauthorized" }, 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<{ listing_id: string }[]>`
        select listing_id from public.saved_listings where user_id = ${c.get("user").sub} order by created_at desc limit ${MAX_SAVED}`;
      return c.json({ ids: rows.map((r) => r.listing_id) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/me/saved/{listingId}",
      summary: "Save a listing (keeps the first save's price)",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ listingId: z.string().uuid() }) },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: SavedStateSchema } } },
        401: { description: "Unauthorized" },
        404: err("No such listing"),
        409: err("too_many_saved"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const uid = c.get("user").sub;
      const { listingId } = c.req.valid("param");
      const [l] = await db<{ price_kobo: string }[]>`select price_kobo::text as price_kobo from public.listings where id = ${listingId} and status <> 'draft'`;
      if (!l) return c.json({ error: "not_found" }, 404);
      const n = (await db<{ n: number }[]>`select count(*)::int as n from public.saved_listings where user_id = ${uid}`)[0]?.n ?? 0;
      const [have] = await db`select 1 from public.saved_listings where user_id = ${uid} and listing_id = ${listingId}`;
      if (!have && n >= MAX_SAVED) return c.json({ error: "too_many_saved" }, 409);
      await db`
        insert into public.saved_listings (user_id, listing_id, price_at_save_kobo)
        values (${uid}, ${listingId}, ${l.price_kobo}) on conflict (user_id, listing_id) do nothing`;
      return c.json({ saved: true }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/saved/{listingId}",
      summary: "Unsave a listing",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ listingId: z.string().uuid() }) },
      responses: { 200: { description: "Unsaved", content: { "application/json": { schema: SavedStateSchema } } }, 401: { description: "Unauthorized" }, 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      await db`delete from public.saved_listings where user_id = ${c.get("user").sub} and listing_id = ${c.req.valid("param").listingId}`;
      return c.json({ saved: false }, 200);
    },
  );

  // ── Watches ──────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/watches",
      summary: "My watches, with what they've caught and the market for each",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: { 200: { description: "Watches", content: { "application/json": { schema: WatchListSchema } } }, 401: { description: "Unauthorized" }, 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<{ id: string; label: string; params: SearchParams; ceiling_kobo: string | null; paused: boolean; created_at: Date }[]>`
        select id, label, params, ceiling_kobo::text as ceiling_kobo, paused, created_at from public.watches
        where user_id = ${c.get("user").sub} order by created_at desc`;
      return c.json({ items: await Promise.all(rows.map((w) => watchOut(db, w))) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/watches",
      summary: "Watch a search (21a): ping me when something matches at or under the ceiling",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { required: true, content: { "application/json": { schema: WatchCreateSchema } } } },
      responses: {
        201: { description: "Watching", content: { "application/json": { schema: WatchSchema } } },
        400: err("Bad request"),
        401: { description: "Unauthorized" },
        409: err("too_many_watches"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const uid = c.get("user").sub;
      const b = c.req.valid("json");
      const n = (await db<{ n: number }[]>`select count(*)::int as n from public.watches where user_id = ${uid}`)[0]?.n ?? 0;
      if (n >= MAX_WATCHES) return c.json({ error: "too_many_watches" }, 409);
      const ceiling = b.ceilingKobo ?? b.filters.maxPrice ?? null;
      // The reading's own place wins over where they were browsing (as search does).
      const place = b.filters.state ? { state: b.filters.state, city: b.filters.city } : { state: b.state, city: b.city };
      const params = strip({ ...b.filters, ...place, lane: b.lane, q: b.keywords, maxPrice: ceiling ?? undefined }) as SearchParams;
      const [w] = await db<{ id: string; label: string; params: SearchParams; ceiling_kobo: string | null; paused: boolean; created_at: Date }[]>`
        insert into public.watches (user_id, label, params, ceiling_kobo)
        values (${uid}, ${b.label}, ${db.json(params as never)}, ${ceiling})
        returning id, label, params, ceiling_kobo::text as ceiling_kobo, paused, created_at`;
      // What already matches is shown straight away, not pushed (they're looking at it).
      await db`
        insert into public.watch_hits (watch_id, listing_id, price_kobo, notified)
        select ${w!.id}, id, price_kobo, false from public.listings
        where ${searchWhere(db, params)} and seller_id <> ${uid}
        order by created_at desc limit 20
        on conflict do nothing`;
      return c.json(await watchOut(db, w!), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me/watches/{id}",
      summary: "Switch a watch on or off (20k toggle)",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { required: true, content: { "application/json": { schema: WatchUpdateSchema } } },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: WatchSchema } } },
        401: { description: "Unauthorized" },
        404: err("Not found"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const [w] = await db<{ id: string; label: string; params: SearchParams; ceiling_kobo: string | null; paused: boolean; created_at: Date }[]>`
        update public.watches set paused = ${c.req.valid("json").paused}
        where id = ${c.req.valid("param").id} and user_id = ${c.get("user").sub}
        returning id, label, params, ceiling_kobo::text as ceiling_kobo, paused, created_at`;
      if (!w) return c.json({ error: "not_found" }, 404);
      return c.json(await watchOut(db, w), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/watches/{id}",
      summary: "Stop watching",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: { 204: { description: "Gone" }, 401: { description: "Unauthorized" }, 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      await db`delete from public.watches where id = ${c.req.valid("param").id} and user_id = ${c.get("user").sub}`;
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/watches/{id}/dismiss",
      summary: "Dismiss one listing a watch caught (20k Dismiss)",
      tags: ["saved"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { required: true, content: { "application/json": { schema: DismissSchema } } },
      },
      responses: { 204: { description: "Dismissed" }, 401: { description: "Unauthorized" }, 404: err("Not found"), 503: err("Database unavailable") },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const r = await db`
        update public.watch_hits h set dismissed_at = now()
        from public.watches w
        where h.watch_id = w.id and w.id = ${c.req.valid("param").id} and w.user_id = ${c.get("user").sub}
          and h.listing_id = ${c.req.valid("json").listingId}`;
      if (!r.count) return c.json({ error: "not_found" }, 404);
      return c.body(null, 204);
    },
  );
}
