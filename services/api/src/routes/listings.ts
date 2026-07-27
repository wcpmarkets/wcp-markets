import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { NG_REGIONS, areaCentre, isState } from "../data/ng-regions.js";
import {
  LISTING_IMAGES_BUCKET,
  createSignedDownloadUrl,
  createSignedUploadUrl,
} from "../supabase.js";

/**
 * M1 — Goods listings + Storage. CRUD through the service-role API (business
 * rules in one auditable place); images live in the private `listing-images`
 * bucket, reached only via short-lived signed URLs the API mints. `lane` and
 * `category` stay separate; M1 is Goods-only (the DB CHECKs lane='goods').
 */

const CONDITIONS = ["new", "used", "refurbished"] as const;
const STATUSES = ["draft", "active", "sold", "archived"] as const;
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

// ── Schemas (all named → clean TS/Kotlin/Swift codegen) ──────────────────────
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ListingSchema = z
  .object({
    id: z.string().uuid(),
    sellerId: z.string().uuid(),
    lane: z.literal("goods"),
    category: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    priceKobo: z.number().int().nonnegative(),
    currency: z.literal("NGN"),
    negotiable: z.boolean(),
    stock: z.number().int().nonnegative(),
    condition: z.enum(CONDITIONS),
    location: z.string().nullable(),
    // Structured location. `location` stays as the seller's own words (shown on
    // the card); these two are what browsing groups and filters by.
    state: z.string().nullable(),
    city: z.string().nullable(),
    status: z.enum(STATUSES),
    imageUrls: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Listing");

const ListingCreateSchema = z
  .object({
    category: z.string().min(1).max(64),
    title: z.string().min(1).max(140),
    description: z.string().max(4000).optional(),
    priceKobo: z.number().int().nonnegative(),
    negotiable: z.boolean().optional(),
    stock: z.number().int().nonnegative().optional(),
    condition: z.enum(CONDITIONS).optional(),
    location: z.string().max(120).optional(),
    // Must be a canonical state/area pair (see ng-regions). lat/lng is the
    // seller's own coarse fix — the only thing that makes a distance ring real.
    state: z.string().max(64).optional(),
    city: z.string().max(64).optional(),
    // format:double so generated clients emit a JSON number, not a BigDecimal
    // string (the client's BigDecimal adapter stringifies, which z.number rejects).
    lat: z.number().min(-90).max(90).openapi({ format: "double" }).optional(),
    lng: z.number().min(-180).max(180).openapi({ format: "double" }).optional(),
  })
  .openapi("ListingCreate");

const ListingUpdateSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(140).optional(),
    description: z.string().max(4000).nullable().optional(),
    priceKobo: z.number().int().nonnegative().optional(),
    negotiable: z.boolean().optional(),
    stock: z.number().int().nonnegative().optional(),
    condition: z.enum(CONDITIONS).optional(),
    location: z.string().max(120).nullable().optional(),
    state: z.string().max(64).optional(),
    city: z.string().max(64).optional(),
    status: z.enum(STATUSES).optional(),
  })
  .openapi("ListingUpdate");

const ListingPageSchema = z
  .object({
    items: z.array(ListingSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi("ListingPage");

const ListingSearchPageSchema = z
  .object({
    items: z.array(ListingSchema),
    nextOffset: z.number().int().nullable(),
  })
  .openapi("ListingSearchPage");

// ── Location facets ─────────────────────────────────────────────────────────
// One payload drives both the buyer's location picker (every state and area,
// with how many active listings each holds) and the seller's post-a-listing
// picker (the canonical names to choose from). Zero-count regions are included
// deliberately: an empty state must still be selectable, and the seller's list
// can't be limited to places that already have stock.
const AreaFacetSchema = z
  .object({
    city: z.string(),
    count: z.number().int().nonnegative(),
    lat: z.number(),
    lng: z.number(),
  })
  .openapi("AreaFacet");

const StateFacetSchema = z
  .object({
    state: z.string(),
    count: z.number().int().nonnegative(),
    cities: z.array(AreaFacetSchema),
  })
  .openapi("StateFacet");

const LocationFacetsSchema = z
  .object({
    /** Active listings nationwide, including any we couldn't place. */
    total: z.number().int().nonnegative(),
    states: z.array(StateFacetSchema),
  })
  .openapi("LocationFacets");

const ImageUploadRequestSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .openapi("ImageUploadRequest");

const ImageUploadSchema = z
  .object({ path: z.string(), uploadUrl: z.string() })
  .openapi("ImageUpload");

// Raw DB shape (bigint arrives as string from postgres.js).
type Row = {
  id: string;
  seller_id: string;
  lane: string;
  category: string;
  title: string;
  description: string | null;
  price_kobo: string | number;
  currency: string;
  negotiable: boolean;
  stock: number;
  condition: (typeof CONDITIONS)[number];
  location: string | null;
  state: string | null;
  city: string | null;
  image_paths: string[];
  status: (typeof STATUSES)[number];
  created_at: string | Date;
  updated_at: string | Date;
};

const iso = (v: string | Date): string =>
  typeof v === "string" ? v : v.toISOString();

/** Map a row to the API shape, signing a download URL for each stored image. */
async function toListing(r: Row): Promise<z.infer<typeof ListingSchema>> {
  const imageUrls = (
    await Promise.all(
      (r.image_paths ?? []).map((p) =>
        createSignedDownloadUrl(LISTING_IMAGES_BUCKET, p),
      ),
    )
  ).filter((u): u is string => !!u);

  return {
    id: r.id,
    sellerId: r.seller_id,
    lane: "goods",
    category: r.category,
    title: r.title,
    description: r.description,
    priceKobo: Number(r.price_kobo),
    currency: "NGN",
    negotiable: r.negotiable,
    stock: r.stock,
    condition: r.condition,
    location: r.location,
    state: r.state,
    city: r.city,
    status: r.status,
    imageUrls,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const SELECT = `id, seller_id, lane, category, title, description, price_kobo,
  currency, negotiable, stock, condition, location, state, city, image_paths,
  status, created_at, updated_at`;

/** Query params every browse surface shares, so /listings and /listings/search
 * scope identically. */
const LocationQuery = {
  state: z.string().max(64).optional(),
  city: z.string().max(64).optional(),
  /** "Near me": the buyer's own point, with radiusKm, as a scope in its own right. */
  nearLat: z.coerce.number().min(-90).max(90).optional(),
  nearLng: z.coerce.number().min(-180).max(180).optional(),
  radiusKm: z.coerce.number().int().min(1).max(500).optional(),
};

/**
 * Turn a location query into a SQL predicate. Four scopes, no overlap:
 *
 * - nothing                    → nationwide
 * - state                      → the whole state
 * - state + city               → that area
 * - nearLat/nearLng + radiusKm → a ring around the buyer, wherever they are
 *
 * "Near me" is deliberately NOT a modifier on an area. Our second level is
 * neighbourhoods — Gwarinpa is about 4 km across — so a ring anchored to an area
 * either changes nothing (every radius contains the whole area) or overshoots it
 * wildly (25 km around Yaba reaches Ikorodu). Distance only earns its place when
 * it's measured from the person asking, which is a question the area tree can't
 * answer at all. So it wins outright when supplied, and ignores state/city.
 *
 * A listing whose seller didn't share a point is anchored to its area centre, so
 * "near me" places it within a kilometre or two of the truth — good enough for a
 * ring, and the honest limit of what we know.
 *
 * An unknown state/area is not silently ignored: it narrows to nothing, because
 * quietly widening a filter the user set is worse than an empty result.
 */
function locationWhere(
  db: NonNullable<Awaited<ReturnType<typeof getDb>>>,
  q: {
    state?: string;
    city?: string;
    nearLat?: number;
    nearLng?: number;
    radiusKm?: number;
  },
) {
  if (q.nearLat != null && q.nearLng != null && q.radiusKm) {
    const metres = q.radiusKm * 1000;
    // earth_box first so the GiST index does the coarse work; earth_distance
    // then trims the box corners to a true circle.
    return db`lat is not null
              and earth_box(ll_to_earth(${q.nearLat}, ${q.nearLng}), ${metres}) @> ll_to_earth(lat, lng)
              and earth_distance(ll_to_earth(${q.nearLat}, ${q.nearLng}), ll_to_earth(lat, lng)) <= ${metres}`;
  }
  if (!q.state) return null;
  if (!q.city) return db`state = ${q.state}`;
  return db`state = ${q.state} and city = ${q.city}`;
}

export function registerListings(app: OpenAPIHono<AuthEnv>) {
  // ── POST /listings ─────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings",
      summary: "Create a Goods listing",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        body: {
          content: { "application/json": { schema: ListingCreateSchema } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: ListingSchema } },
        },
        401: { description: "Unauthorized" },
        422: {
          description: "Location is not a known state/area",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");

      // Only canonical pairs are stored: a typo'd area would be invisible to
      // every filter and facet while looking fine on the card.
      if (b.state && !isState(b.state)) {
        return c.json({ error: "unknown_state" }, 422);
      }
      const centre = b.state && b.city ? areaCentre(b.state, b.city) : null;
      if (b.city && !centre) {
        return c.json({ error: "unknown_city" }, 422);
      }
      // A seller who won't share their location still gets placed, at the centre
      // of the area they chose. Without this they'd be tagged to an area but fall
      // out of every ring drawn around it, which reads as a bug.
      const lat = b.lat ?? centre?.lat ?? null;
      const lng = b.lng ?? centre?.lng ?? null;
      const rows = await db<Row[]>`
        insert into public.listings
          (seller_id, category, title, description, price_kobo, negotiable, stock,
           condition, location, state, city, lat, lng)
        values (
          ${user.sub}, ${b.category}, ${b.title}, ${b.description ?? null},
          ${b.priceKobo}, ${b.negotiable ?? true}, ${b.stock ?? 1},
          ${b.condition ?? "used"}, ${b.location ?? null},
          ${b.state ?? null}, ${b.city ?? null}, ${lat}, ${lng}
        )
        returning ${db.unsafe(SELECT)}
      `;
      return c.json(await toListing(rows[0]!), 201);
    },
  );

  // ── GET /listings — public browse (newest active first, keyset) ─────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings",
      summary: "Browse active listings",
      tags: ["listings"],
      request: {
        query: z.object({
          ...LocationQuery,
          limit: z.coerce.number().int().min(1).max(50).optional(),
          cursor: z.string().datetime().optional(),
        }),
      },
      responses: {
        200: {
          description: "A page of active listings",
          content: { "application/json": { schema: ListingPageSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { limit, cursor, ...loc } = c.req.valid("query");
      const take = limit ?? 20;
      const place = locationWhere(db, loc);

      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where status = 'active'
          ${place ? db`and (${place})` : db``}
          ${cursor ? db`and created_at < ${cursor}` : db``}
        order by created_at desc
        limit ${take}
      `;
      const items = await Promise.all(rows.map(toListing));
      const nextCursor =
        rows.length === take ? iso(rows[rows.length - 1]!.created_at) : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  // ── GET /listings/search — full-text + fuzzy + filters (ranked) ─────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/search",
      summary: "Search active listings (full-text + filters)",
      tags: ["listings"],
      request: {
        query: z.object({
          q: z.string().max(120).optional(),
          category: z.string().max(64).optional(),
          condition: z.enum(CONDITIONS).optional(),
          minPrice: z.coerce.number().int().nonnegative().optional(),
          maxPrice: z.coerce.number().int().nonnegative().optional(),
          location: z.string().max(120).optional(),
          ...LocationQuery,
          limit: z.coerce.number().int().min(1).max(50).optional(),
          offset: z.coerce.number().int().min(0).optional(),
        }),
      },
      responses: {
        200: {
          description: "Ranked search results",
          content: { "application/json": { schema: ListingSearchPageSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { q, category, condition, minPrice, maxPrice, location, ...rest } =
        c.req.valid("query");
      const limit = c.req.valid("query").limit ?? 20;
      const offset = c.req.valid("query").offset ?? 0;
      const place = locationWhere(db, rest);

      // Compose the WHERE by nesting postgres.js fragments (all values bound).
      let where = db`status = 'active'`;
      if (category) where = db`${where} and category = ${category}`;
      if (condition) where = db`${where} and condition = ${condition}`;
      if (minPrice != null) where = db`${where} and price_kobo >= ${minPrice}`;
      if (maxPrice != null) where = db`${where} and price_kobo <= ${maxPrice}`;
      if (location) where = db`${where} and location ilike ${"%" + location + "%"}`;
      if (place) where = db`${where} and (${place})`;
      if (q)
        // FTS match OR a fuzzy word-similarity match on the title (typo tolerance;
        // word_similarity finds the best-matching word within the title, so a long
        // title still matches a single mistyped term).
        where = db`${where} and (search_vector @@ websearch_to_tsquery('english', ${q}) or word_similarity(${q}, title) > 0.25)`;

      // Rank by FTS relevance, then fuzzy closeness; else newest first.
      const order = q
        ? db`order by ts_rank(search_vector, websearch_to_tsquery('english', ${q})) desc, word_similarity(${q}, title) desc, created_at desc`
        : db`order by created_at desc`;

      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where ${where}
        ${order}
        limit ${limit} offset ${offset}
      `;
      const items = await Promise.all(rows.map(toListing));
      const nextOffset = rows.length === limit ? offset + limit : null;
      return c.json({ items, nextOffset }, 200);
    },
  );

  // ── GET /listings/facets — the location tree, with counts ──────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/facets",
      summary: "States and areas with active-listing counts",
      tags: ["listings"],
      responses: {
        200: {
          description: "The canonical location tree with counts",
          content: { "application/json": { schema: LocationFacetsSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);

      const rows = await db<{ state: string | null; city: string | null; n: number }[]>`
        select state, city, count(*)::int as n
        from public.listings
        where status = 'active'
        group by state, city
      `;

      const perState = new Map<string, number>();
      const perCity = new Map<string, number>();
      let total = 0;
      for (const r of rows) {
        total += r.n;
        if (!r.state) continue; // unplaced: counts nationwide only
        perState.set(r.state, (perState.get(r.state) ?? 0) + r.n);
        if (r.city) {
          const k = `${r.state} ${r.city}`;
          perCity.set(k, (perCity.get(k) ?? 0) + r.n);
        }
      }

      // Driven by the canonical list, not by what happens to have stock, so
      // every state and area stays selectable (and postable) at zero.
      const states = NG_REGIONS.map((region) => ({
        state: region.state,
        count: perState.get(region.state) ?? 0,
        cities: region.areas.map((a) => ({
          city: a.city,
          count: perCity.get(`${region.state} ${a.city}`) ?? 0,
          lat: a.lat,
          lng: a.lng,
        })),
      }));

      return c.json({ total, states }, 200);
    },
  );

  // ── GET /listings/mine — the caller's own listings (incl. drafts) ───────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/mine",
      summary: "The caller's own listings",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: {
          description: "The caller's listings",
          content: { "application/json": { schema: z.array(ListingSchema) } },
        },
        401: { description: "Unauthorized" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where seller_id = ${user.sub}
        order by created_at desc
      `;
      return c.json(await Promise.all(rows.map(toListing)), 200);
    },
  );

  // ── GET /listings/{id} — public read of an active listing ───────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/{id}",
      summary: "Read an active listing",
      tags: ["listings"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: {
          description: "The listing",
          content: { "application/json": { schema: ListingSchema } },
        },
        404: { description: "Not found" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where id = ${id} and status = 'active'
      `;
      if (!rows[0]) return c.json({ error: "not_found" }, 404);
      return c.json(await toListing(rows[0]), 200);
    },
  );

  // ── PATCH /listings/{id} — edit own listing ─────────────────────────────────
  app.openapi(
    createRoute({
      method: "patch",
      path: "/listings/{id}",
      summary: "Edit own listing",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ListingUpdateSchema } } },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: ListingSchema } },
        },
        401: { description: "Unauthorized" },
        404: { description: "Not found or not owner" },
        422: {
          description: "Location is not a known state/area",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");

      // Only the columns present in the body; map API → column names.
      const cols: Record<string, unknown> = {};
      if (b.category !== undefined) cols.category = b.category;
      if (b.title !== undefined) cols.title = b.title;
      if (b.description !== undefined) cols.description = b.description;
      if (b.priceKobo !== undefined) cols.price_kobo = b.priceKobo;
      if (b.negotiable !== undefined) cols.negotiable = b.negotiable;
      if (b.stock !== undefined) cols.stock = b.stock;
      if (b.condition !== undefined) cols.condition = b.condition;
      if (b.location !== undefined) cols.location = b.location;
      if (b.status !== undefined) cols.status = b.status;
      // Moving a listing means moving both halves of the pair, and only to a
      // canonical area — the create path holds the same line.
      if (b.state !== undefined || b.city !== undefined) {
        if (!b.state || !b.city || !areaCentre(b.state, b.city)) {
          return c.json({ error: "unknown_city" }, 422);
        }
        const centre = areaCentre(b.state, b.city)!;
        cols.state = b.state;
        cols.city = b.city;
        // Re-anchor the point to the new area unless the seller re-posts their
        // own fix; a stale coordinate would put the listing in the wrong ring.
        cols.lat = centre.lat;
        cols.lng = centre.lng;
      }

      if (Object.keys(cols).length === 0) {
        // Nothing to change — return the current row (owner-scoped).
        const rows = await db<Row[]>`
          select ${db.unsafe(SELECT)} from public.listings
          where id = ${id} and seller_id = ${user.sub}
        `;
        if (!rows[0]) return c.json({ error: "not_found" }, 404);
        return c.json(await toListing(rows[0]), 200);
      }

      const rows = await db<Row[]>`
        update public.listings set ${db(cols)}
        where id = ${id} and seller_id = ${user.sub}
        returning ${db.unsafe(SELECT)}
      `;
      if (!rows[0]) return c.json({ error: "not_found" }, 404);
      return c.json(await toListing(rows[0]), 200);
    },
  );

  // ── POST /listings/{id}/images — mint a signed upload URL, attach the path ──
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/images",
      summary: "Get a signed upload URL for a listing image",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ImageUploadRequestSchema } } },
      },
      responses: {
        200: {
          description: "Signed upload URL (PUT the image bytes to it)",
          content: { "application/json": { schema: ImageUploadSchema } },
        },
        401: { description: "Unauthorized" },
        404: { description: "Not found or not owner" },
        409: {
          description: "Image limit reached",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Storage/DB unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { contentType } = c.req.valid("json");

      const owned = await db<{ image_paths: string[] }[]>`
        select image_paths from public.listings
        where id = ${id} and seller_id = ${user.sub}
      `;
      if (!owned[0]) return c.json({ error: "not_found" }, 404);
      if ((owned[0].image_paths?.length ?? 0) >= 10)
        return c.json({ error: "image_limit_reached" }, 409);

      const ext = IMAGE_TYPES[contentType];
      const path = `${user.sub}/${id}/${randomUUID()}.${ext}`;
      const signed = await createSignedUploadUrl(LISTING_IMAGES_BUCKET, path);
      if (!signed) return c.json({ error: "storage_unavailable" }, 503);

      // Attach the path now; a failed upload leaves a dangling key (swept later).
      await db`
        update public.listings
        set image_paths = array_append(image_paths, ${path})
        where id = ${id} and seller_id = ${user.sub}
      `;
      return c.json({ path, uploadUrl: signed.uploadUrl }, 200);
    },
  );
}
