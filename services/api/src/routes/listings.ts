import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { NG_REGIONS, areaCentre, isState } from "../data/ng-regions.js";
import {
  BODIES,
  FUELS,
  MIN_YEAR,
  REGISTRATIONS,
  TRANSMISSIONS,
  VEHICLE_CONDITIONS,
  isKnownMake,
  maxYear,
} from "../data/vehicles.js";
import { AVAILABILITY, COVERAGE_KM, MAX_RATE_ITEMS, isServiceGroup } from "../data/services.js";
import {
  LISTING_IMAGES_BUCKET,
  createSignedDownloadUrl,
  createSignedUploadUrl,
} from "../supabase.js";
import type { Sql } from "../deals/commands.js";
import { UserSummarySchema, userSummaries, type UserSummary } from "../profiles/summary.js";

/**
 * M1 — Goods listings + Storage. CRUD through the service-role API (business
 * rules in one auditable place); images live in the private `listing-images`
 * bucket, reached only via short-lived signed URLs the API mints. `lane` and
 * `category` stay separate; M1 is Goods-only (the DB CHECKs lane='goods').
 */

const CONDITIONS = ["new", "used", "refurbished"] as const;
/** Statuses a seller may set. */
const SELLER_STATUSES = ["draft", "active", "sold", "archived"] as const;
/**
 * Every status a listing can be in. under_review (paused by reports) and removed
 * (taken down by staff) are set only by moderation — migration 0023's trigger
 * enforces it — and, like drafts, are never publicly readable.
 */
const STATUSES = [...SELLER_STATUSES, "under_review", "removed"] as const;
const MODERATED: readonly string[] = ["under_review", "removed"];
const LANES = ["goods", "property", "vehicles", "services"] as const;
const PROPERTY_TYPES = ["apartment", "house", "land", "commercial", "shop", "office"] as const;
const DEAL_TYPES = ["rent", "sale"] as const;
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

// ── Schemas (all named → clean TS/Kotlin/Swift codegen) ──────────────────────
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

// Lane-specific facets (a JSON attribute set). All optional here; the API requires
// the right ones per lane (see the create handler). Property: type, rent|sale,
// beds, baths. Vehicles: make, model, year, mileage, transmission, fuel, body,
// condition, registration (design 13h).
/** One line of a provider's rate card (13i): a price "from", or none = "Quote". */
const RateItemSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    fromKobo: z.number().int().positive().optional(),
  })
  .openapi("RateItem");

const ListingAttributesSchema = z
  .object({
    propertyType: z.enum(PROPERTY_TYPES).optional(),
    dealType: z.enum(DEAL_TYPES).optional(),
    beds: z.number().int().min(0).max(50).optional(),
    baths: z.number().int().min(0).max(50).optional(),
    make: z.string().trim().min(1).max(40).optional(),
    model: z.string().trim().min(1).max(40).optional(),
    year: z.number().int().optional(),
    mileageKm: z.number().int().min(0).max(2_000_000).optional(),
    transmission: z.enum(TRANSMISSIONS).optional(),
    fuel: z.enum(FUELS).optional(),
    body: z.enum(BODIES).optional(),
    vehicleCondition: z.enum(VEHICLE_CONDITIONS).optional(),
    registration: z.enum(REGISTRATIONS).optional(),
    // Services (13i): the type within the category group, the rate card, where the
    // provider travels (a ring around their area, or anywhere in the state), and
    // optional availability flags buyers filter on.
    serviceType: z.string().trim().min(1).max(60).optional(),
    rateCard: z.array(RateItemSchema).max(MAX_RATE_ITEMS).optional(),
    coverageKm: z.number().int().optional(),
    coverageAnywhere: z.boolean().optional(),
    availability: z.array(z.enum(AVAILABILITY)).max(AVAILABILITY.length).optional(),
  })
  .openapi("ListingAttributes");

/**
 * Services must say what they are, carry at least one rate line, and say where they
 * cover — coverage is the lane's primary search facet, so it needs a real area.
 */
function serviceProblem(
  category: string,
  a: z.infer<typeof ListingAttributesSchema> | undefined,
  state: string | undefined,
  city: string | undefined,
): string | null {
  if (!isServiceGroup(category)) return "unknown_service_category";
  if (!a?.serviceType || !a.rateCard?.length) return "service_needs_details";
  if (!state || !city) return "service_needs_area";
  if (!a.coverageAnywhere && !(COVERAGE_KM as readonly number[]).includes(a.coverageKm ?? -1)) {
    return "service_needs_coverage";
  }
  return null;
}

/** A service's card price is its cheapest "from" line; all-quote cards show "Quote" (0). */
function serviceFromKobo(a: z.infer<typeof ListingAttributesSchema> | undefined): number {
  const prices = (a?.rateCard ?? []).map((i) => i.fromKobo).filter((k): k is number => k != null);
  return prices.length ? Math.min(...prices) : 0;
}

/** Vehicles must carry every facet the lane's cards, filters and detail show. */
function vehicleProblem(a: z.infer<typeof ListingAttributesSchema> | undefined): string | null {
  if (!a?.make || !a.model || a.year == null || a.mileageKm == null || !a.transmission || !a.fuel ||
      !a.body || !a.vehicleCondition || !a.registration) {
    return "vehicle_needs_details";
  }
  if (!isKnownMake(a.make)) return "unknown_make";
  if (a.year < MIN_YEAR || a.year > maxYear()) return "invalid_year";
  return null;
}

const ListingSchema = z
  .object({
    id: z.string().uuid(),
    sellerId: z.string().uuid(),
    /** The seller's public face (name, store, photo, verified) — never their phone. */
    seller: UserSummarySchema,
    lane: z.enum(LANES),
    category: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    priceKobo: z.number().int().nonnegative(),
    currency: z.literal("NGN"),
    negotiable: z.boolean(),
    stock: z.number().int().nonnegative(),
    condition: z.enum(CONDITIONS),
    attributes: ListingAttributesSchema,
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
    // Omit for Goods (defaults). Property requires attributes (validated in the handler).
    lane: z.enum(LANES).default("goods"),
    category: z.string().min(1).max(64),
    title: z.string().min(1).max(140),
    description: z.string().max(4000).optional(),
    priceKobo: z.number().int().nonnegative(),
    negotiable: z.boolean().optional(),
    stock: z.number().int().nonnegative().optional(),
    condition: z.enum(CONDITIONS).optional(),
    attributes: ListingAttributesSchema.optional(),
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
    status: z.enum(SELLER_STATUSES).optional(),
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
  attributes: Record<string, unknown> | null;
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
async function toListing(r: Row, seller: UserSummary): Promise<z.infer<typeof ListingSchema>> {
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
    seller,
    lane: r.lane as (typeof LANES)[number],
    category: r.category,
    title: r.title,
    description: r.description,
    priceKobo: Number(r.price_kobo),
    currency: "NGN",
    negotiable: r.negotiable,
    stock: r.stock,
    condition: r.condition,
    attributes: (r.attributes ?? {}) as z.infer<typeof ListingAttributesSchema>,
    location: r.location,
    state: r.state,
    city: r.city,
    status: r.status,
    imageUrls,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

/** Map rows to the API shape, batch-loading each distinct seller's summary once. */
async function toListings(db: Sql, rows: Row[]): Promise<z.infer<typeof ListingSchema>[]> {
  const sellers = await userSummaries(db, rows.map((r) => r.seller_id));
  return Promise.all(rows.map((r) => toListing(r, sellers.get(r.seller_id)!)));
}

const SELECT = `id, seller_id, lane, category, title, description, price_kobo,
  currency, negotiable, stock, condition, attributes, location, state, city, image_paths,
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
      // Property must say what it is and whether it's to rent or buy — those two
      // drive the whole browse/display shell for the lane.
      if (b.lane === "property" && (!b.attributes?.propertyType || !b.attributes?.dealType)) {
        return c.json({ error: "property_needs_type_and_deal" }, 422);
      }
      // Vehicles: every facet, from the catalogue's makes (or "Other"). A car is one
      // unit, and the goods condition column mirrors its new/used state.
      if (b.lane === "vehicles") {
        const problem = vehicleProblem(b.attributes);
        if (problem) return c.json({ error: problem }, 422);
      }
      if (b.lane === "services") {
        const problem = serviceProblem(b.category, b.attributes, b.state, b.city);
        if (problem) return c.json({ error: problem }, 422);
      }
      // A service's listed price is derived from its rate card, never typed twice.
      const priceKobo = b.lane === "services" ? serviceFromKobo(b.attributes) : b.priceKobo;
      // A seller who won't share their location still gets placed, at the centre
      // of the area they chose. Without this they'd be tagged to an area but fall
      // out of every ring drawn around it, which reads as a bug.
      const lat = b.lat ?? centre?.lat ?? null;
      const lng = b.lng ?? centre?.lng ?? null;
      const rows = await db<Row[]>`
        insert into public.listings
          (seller_id, lane, category, title, description, price_kobo, negotiable, stock,
           condition, attributes, location, state, city, lat, lng)
        values (
          ${user.sub}, ${b.lane}, ${b.category}, ${b.title}, ${b.description ?? null},
          ${priceKobo}, ${b.negotiable ?? true}, ${b.lane === "vehicles" || b.lane === "services" ? 1 : (b.stock ?? 1)},
          ${b.lane === "vehicles" ? (b.attributes?.vehicleCondition === "brand_new" ? "new" : "used") : (b.condition ?? "used")},
          ${db.json(b.attributes ?? {})},
          ${b.location ?? null}, ${b.state ?? null}, ${b.city ?? null}, ${lat}, ${lng}
        )
        returning ${db.unsafe(SELECT)}
      `;
      return c.json((await toListings(db, [rows[0]!]))[0]!, 201);
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
          lane: z.enum(LANES).optional(),
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
      const { limit, cursor, lane, ...loc } = c.req.valid("query");
      const take = limit ?? 20;
      const place = locationWhere(db, loc);

      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where status = 'active'
          ${lane ? db`and lane = ${lane}` : db``}
          ${place ? db`and (${place})` : db``}
          ${cursor ? db`and created_at < ${cursor}` : db``}
        order by created_at desc
        limit ${take}
      `;
      const items = await toListings(db, rows);
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
          lane: z.enum(LANES).optional(),
          category: z.string().max(64).optional(),
          condition: z.enum(CONDITIONS).optional(),
          minPrice: z.coerce.number().int().nonnegative().optional(),
          maxPrice: z.coerce.number().int().nonnegative().optional(),
          location: z.string().max(120).optional(),
          ...LocationQuery,
          // Vehicles (13e-filters-vehicles).
          make: z.string().max(40).optional(),
          model: z.string().max(40).optional(),
          minYear: z.coerce.number().int().optional(),
          maxYear: z.coerce.number().int().optional(),
          maxMileageKm: z.coerce.number().int().nonnegative().optional(),
          transmission: z.enum(TRANSMISSIONS).optional(),
          fuel: z.enum(FUELS).optional(),
          body: z.enum(BODIES).optional(),
          vehicleCondition: z.enum(VEHICLE_CONDITIONS).optional(),
          registration: z.enum(REGISTRATIONS).optional(),
          // Services (22c browse): the type within a group, and availability flags.
          serviceType: z.string().max(60).optional(),
          availability: z.enum(AVAILABILITY).optional(),
          /** relevance (default; newest when there's no query), price, newest, or lowest mileage. */
          sort: z.enum(["relevance", "price_asc", "price_desc", "newest", "mileage_asc"]).optional(),
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
      const {
        q, lane, category, condition, minPrice, maxPrice, location,
        make, model, minYear, maxYear: maxYr, maxMileageKm, transmission, fuel, body,
        vehicleCondition, registration, serviceType, availability, sort, ...rest
      } = c.req.valid("query");
      const limit = c.req.valid("query").limit ?? 20;
      const offset = c.req.valid("query").offset ?? 0;
      const place = locationWhere(db, rest);

      // Compose the WHERE by nesting postgres.js fragments (all values bound).
      let where = db`status = 'active'`;
      if (lane) where = db`${where} and lane = ${lane}`;
      if (category) where = db`${where} and category = ${category}`;
      if (condition) where = db`${where} and condition = ${condition}`;
      if (minPrice != null) where = db`${where} and price_kobo >= ${minPrice}`;
      if (maxPrice != null) where = db`${where} and price_kobo <= ${maxPrice}`;
      if (location) where = db`${where} and location ilike ${"%" + location + "%"}`;
      if (place) where = db`${where} and (${place})`;
      // Vehicle facets live in attributes; each filter narrows to cars that carry it.
      if (make) where = db`${where} and attributes->>'make' = ${make}`;
      if (model) where = db`${where} and lower(attributes->>'model') = lower(${model})`;
      if (minYear != null) where = db`${where} and (attributes->>'year')::int >= ${minYear}`;
      if (maxYr != null) where = db`${where} and (attributes->>'year')::int <= ${maxYr}`;
      if (maxMileageKm != null) where = db`${where} and (attributes->>'mileageKm')::int <= ${maxMileageKm}`;
      if (transmission) where = db`${where} and attributes->>'transmission' = ${transmission}`;
      if (fuel) where = db`${where} and attributes->>'fuel' = ${fuel}`;
      if (body) where = db`${where} and attributes->>'body' = ${body}`;
      if (vehicleCondition) where = db`${where} and attributes->>'vehicleCondition' = ${vehicleCondition}`;
      if (registration) where = db`${where} and attributes->>'registration' = ${registration}`;
      if (serviceType) where = db`${where} and attributes->>'serviceType' = ${serviceType}`;
      if (availability) where = db`${where} and attributes->'availability' ? ${availability}`;
      if (q)
        // FTS match OR a fuzzy word-similarity match on the title (typo tolerance;
        // word_similarity finds the best-matching word within the title, so a long
        // title still matches a single mistyped term).
        where = db`${where} and (search_vector @@ websearch_to_tsquery('english', ${q}) or word_similarity(${q}, title) > 0.25)`;

      // Rank by FTS relevance, then fuzzy closeness; else newest first — unless the
      // caller asked for an explicit sort (13e filter sheet).
      const order =
        sort === "price_asc" ? db`order by price_kobo asc, created_at desc`
        : sort === "price_desc" ? db`order by price_kobo desc, created_at desc`
        : sort === "newest" ? db`order by created_at desc`
        : sort === "mileage_asc" ? db`order by (attributes->>'mileageKm')::int asc nulls last, created_at desc`
        : q
          ? db`order by ts_rank(search_vector, websearch_to_tsquery('english', ${q})) desc, word_similarity(${q}, title) desc, created_at desc`
          : db`order by created_at desc`;

      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where ${where}
        ${order}
        limit ${limit} offset ${offset}
      `;
      const items = await toListings(db, rows);
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
      return c.json(await toListings(db, rows), 200);
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
      return c.json((await toListings(db, [rows[0]]))[0]!, 200);
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
        409: {
          description: "Listing is under moderation; its status can't be changed",
          content: { "application/json": { schema: ErrorSchema } },
        },
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
      if (b.status !== undefined) {
        // A listing in moderation keeps its status until staff decide; the seller can
        // still edit its details. (The DB trigger holds the same line.)
        const [cur] = await db<{ status: string }[]>`
          select status from public.listings where id = ${id} and seller_id = ${user.sub}
        `;
        if (!cur) return c.json({ error: "not_found" }, 404);
        if (MODERATED.includes(cur.status) && b.status !== cur.status) {
          return c.json({ error: "listing_under_moderation" }, 409);
        }
        if (b.status !== cur.status) cols.status = b.status;
      }
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
        return c.json((await toListings(db, [rows[0]]))[0]!, 200);
      }

      const rows = await db<Row[]>`
        update public.listings set ${db(cols)}
        where id = ${id} and seller_id = ${user.sub}
        returning ${db.unsafe(SELECT)}
      `;
      if (!rows[0]) return c.json({ error: "not_found" }, 404);
      return c.json((await toListings(db, [rows[0]]))[0]!, 200);
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
