import { type OpenAPIHono, type z as Z, createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import type { AuthEnv } from "../middleware/auth.js";
import { rateLimit, clientIp } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { AVAILABILITY } from "../data/services.js";
import { BODIES, FUELS, REGISTRATIONS, TRANSMISSIONS, VEHICLE_CONDITIONS } from "../data/vehicles.js";
import { CONDITIONS, DEAL_TYPES, LANES, PROPERTY_TYPES, searchWhere, type SearchParams } from "./listings.js";
import { interpretPhoto, interpretText } from "../search/interpret.js";
import { buildSummary, naira, type Filters, type Interpretation, type Lane } from "../search/shape.js";

/**
 * AI search (Phase 3I; designs 13e, 13e-photo, 21a, 22e, 22f).
 *
 * - POST /search/interpret — typed words → lane + filters + keywords + the banner
 *   sentence, plus other readings ("Mustang could also mean…") with live counts.
 * - POST /search/photo — a photo → the same, naming what it shows.
 * - POST /search/suggest — for a search that found nothing: which one change would
 *   find something, and how much (21a), worked out from the listings, not guessed.
 *
 * The client then runs the ordinary GET /listings/search with the result, so ranking,
 * paging and every filter chip behave exactly as a hand-filtered search does.
 * Public (browsing needs no account), so each route is rate-limited by IP.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

export const SearchFiltersSchema = z
  .object({
    category: z.string().optional(),
    condition: z.enum(CONDITIONS).optional(),
    minPrice: z.number().int().optional().openapi({ description: "kobo" }),
    maxPrice: z.number().int().optional().openapi({ description: "kobo" }),
    state: z.string().optional(),
    city: z.string().optional(),
    propertyType: z.enum(PROPERTY_TYPES).optional(),
    dealType: z.enum(DEAL_TYPES).optional(),
    minBeds: z.number().int().optional(),
    make: z.string().optional(),
    model: z.string().optional(),
    minYear: z.number().int().optional(),
    maxYear: z.number().int().optional(),
    maxMileageKm: z.number().int().optional(),
    transmission: z.enum(TRANSMISSIONS).optional(),
    fuel: z.enum(FUELS).optional(),
    body: z.enum(BODIES).optional(),
    vehicleCondition: z.enum(VEHICLE_CONDITIONS).optional(),
    registration: z.enum(REGISTRATIONS).optional(),
    serviceType: z.string().optional(),
    availability: z.enum(AVAILABILITY).optional(),
  })
  .openapi("SearchFilters");

const SearchAlternativeSchema = z
  .object({
    /** Null = every lane (a 21a suggestion like "Browse everything"). */
    lane: z.enum(LANES).nullable(),
    label: z.string(),
    keywords: z.string(),
    filters: SearchFiltersSchema,
    count: z.number().int().optional(),
    fromKobo: z.number().int().nullable().optional(),
  })
  .openapi("SearchAlternative");

const SearchInterpretationSchema = z
  .object({
    source: z.enum(["ai", "rules"]),
    lane: z.enum(LANES).nullable(),
    keywords: z.string(),
    filters: SearchFiltersSchema,
    summary: z.string().openapi({ description: "Banner sentence; **…** marks the bold span." }),
    tossUp: z.boolean(),
    alternatives: z.array(SearchAlternativeSchema),
    itemName: z.string().optional(),
  })
  .openapi("SearchInterpretation");

/** Where the buyer is browsing — the same scopes as /listings/search. */
const scopeFields = {
  state: z.string().max(64).optional(),
  city: z.string().max(64).optional(),
  nearLat: z.number().min(-90).max(90).optional(),
  nearLng: z.number().min(-180).max(180).optional(),
  radiusKm: z.number().int().min(1).max(500).optional(),
};

const InterpretRequestSchema = z
  .object({ q: z.string().trim().min(1).max(200), lane: z.enum(LANES).optional(), ...scopeFields })
  .openapi("SearchInterpretRequest");

/** ~1.5 MB of JPEG once base64'd; the app sends a ≤1024px re-encode, far smaller. */
const MAX_PHOTO_B64 = 2_000_000;
const PhotoRequestSchema = z
  .object({
    imageBase64: z.string().min(100).max(MAX_PHOTO_B64),
    mediaType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    lane: z.enum(LANES).optional(),
    ...scopeFields,
  })
  .openapi("PhotoSearchRequest");

const SuggestRequestSchema = z
  .object({
    lane: z.enum(LANES).nullable().optional(),
    keywords: z.string().max(120).default(""),
    filters: SearchFiltersSchema,
    ...scopeFields,
  })
  .openapi("SearchSuggestRequest");

const SearchSuggestionsSchema = z
  .object({
    /** One honest sentence about why nothing matched (bold spans as **…**). */
    message: z.string(),
    suggestions: z.array(SearchAlternativeSchema),
  })
  .openapi("SearchSuggestions");

type Scope = { state?: string; city?: string; nearLat?: number; nearLng?: number; radiusKm?: number };
type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;

/**
 * A search's params: the interpretation's own place wins over the browse scope (the
 * buyer said "in Lekki"); otherwise it inherits where they're browsing.
 */
function paramsFor(lane: Lane | null | undefined, keywords: string, f: Filters, scope: Scope): SearchParams {
  const place = f.state ? { state: f.state, city: f.city } : scope;
  return { ...f, ...place, lane: lane ?? undefined, q: keywords || undefined };
}

async function countFor(db: Db, p: SearchParams): Promise<{ count: number; fromKobo: number | null }> {
  const rows = await db<{ n: number; lo: string | null }[]>`
    select count(*)::int as n, min(price_kobo) as lo from public.listings where ${searchWhere(db, p)}`;
  return { count: rows[0]?.n ?? 0, fromKobo: rows[0]?.lo != null ? Number(rows[0].lo) : null };
}

/** Attach live counts to the other readings, so 22e can say "312 listings · from ₦85k". */
async function withCounts(out: Interpretation, scope: Scope): Promise<Interpretation> {
  const db = await getDb();
  if (!db || !out.alternatives.length) return out;
  const alternatives = await Promise.all(
    out.alternatives.map(async (a) => ({ ...a, ...(await countFor(db, paramsFor(a.lane, a.keywords, a.filters, scope))) })),
  );
  return { ...out, alternatives };
}

const ipKey = (c: Context) => [clientIp(c)];

export function registerSearch(app: OpenAPIHono<AuthEnv>) {
  // Generous per IP: Nigerian mobile carriers put many people behind one address.
  app.use("/search/interpret", rateLimit({ prefix: "ai-interpret", limit: 120, windowSecs: 600, keys: ipKey }));
  app.use("/search/photo", rateLimit({ prefix: "ai-photo", limit: 30, windowSecs: 3600, keys: ipKey }));
  app.use("/search/suggest", rateLimit({ prefix: "ai-suggest", limit: 120, windowSecs: 600, keys: ipKey }));

  // ── POST /search/interpret ─────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/search/interpret",
      summary: "Read a typed search into a lane, filters and keywords (13e / 22e / 22f)",
      tags: ["search"],
      request: { body: { content: { "application/json": { schema: InterpretRequestSchema } }, required: true } },
      responses: {
        200: { description: "The interpretation", content: { "application/json": { schema: SearchInterpretationSchema } } },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const { q, lane, ...scope } = c.req.valid("json");
      const out = await interpretText(q, lane ?? null);
      return c.json((await withCounts(out, scope)) as Z.infer<typeof SearchInterpretationSchema>, 200);
    },
  );

  // ── POST /search/photo ─────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/search/photo",
      summary: "Identify a photographed item and read it into a search (13e-photo)",
      description: "The photo is sent to the AI provider to identify the item, and is not stored.",
      tags: ["search"],
      request: { body: { content: { "application/json": { schema: PhotoRequestSchema } }, required: true } },
      responses: {
        200: { description: "The interpretation", content: { "application/json": { schema: SearchInterpretationSchema } } },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        503: {
          description: "Photo search isn't available (no AI configured, budget spent, or it couldn't tell)",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const { imageBase64, mediaType, lane, ...scope } = c.req.valid("json");
      const out = await interpretPhoto({ data: imageBase64, mediaType }, lane ?? null);
      if (!out) return c.json({ error: "photo_search_unavailable" }, 503);
      return c.json((await withCounts(out, scope)) as Z.infer<typeof SearchInterpretationSchema>, 200);
    },
  );

  // ── POST /search/suggest — 21a, the zero-results helper ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/search/suggest",
      summary: "For a search with no results: the nearest searches that do have some (21a)",
      tags: ["search"],
      request: { body: { content: { "application/json": { schema: SuggestRequestSchema } }, required: true } },
      responses: {
        200: { description: "Suggestions", content: { "application/json": { schema: SearchSuggestionsSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { lane, keywords, filters, ...scope } = c.req.valid("json");
      return c.json(await suggest(db, lane ?? null, keywords, filters as Filters, scope), 200);
    },
  );
}

/**
 * Relax one thing at a time, in the order a buyer would: the budget, then the
 * condition-like facets, then the area, then the words. Report the first few that
 * find something, with their counts. The sentence states facts from the listings
 * ("the cheapest match is ₦850k"), never market claims we can't back.
 */
async function suggest(db: Db, lane: Lane | null, keywords: string, f: Filters, scope: Scope) {
  const out: Z.infer<typeof SearchAlternativeSchema>[] = [];
  let message: string | null = null;
  /** Count one relaxation; keep it if it finds something. The first to do so explains the gap. */
  const tryOne = async (label: string, l: Lane | null, k: string, nf: Filters, why: string, sc: Scope = scope) => {
    if (out.length >= 3) return null;
    const r = await countFor(db, paramsFor(l, k, nf, sc));
    if (r.count > 0) {
      out.push({ lane: l, label, keywords: k, filters: nf, ...r });
      message ??= why;
    }
    return r;
  };
  const without = (...keys: (keyof Filters)[]) => {
    const n: Filters = { ...f };
    for (const k of keys) delete n[k];
    return n;
  };

  // 1. The budget.
  if (f.maxPrice != null) {
    const r = await countFor(db, paramsFor(lane, keywords, without("maxPrice"), scope));
    if (r.count > 0 && r.fromKobo != null) {
      message = `Nothing under **${naira(f.maxPrice)}** right now — the cheapest match is **${naira(r.fromKobo)}**.`;
      const atCheapest = await countFor(db, paramsFor(lane, keywords, { ...f, maxPrice: r.fromKobo }, scope));
      out.push({ lane, label: `Raise budget to ${naira(r.fromKobo)}`, keywords, filters: { ...f, maxPrice: r.fromKobo }, ...atCheapest });
      // "Any price" only earns a row when it shows more than the raised budget does.
      if (r.count > atCheapest.count) out.push({ lane, label: "Any price", keywords, filters: without("maxPrice"), ...r });
    }
  }
  if (f.minPrice != null) await tryOne("Any price", lane, keywords, without("minPrice", "maxPrice"), `Nothing over **${naira(f.minPrice)}** right now.`);

  // 2. Facets that narrow hard.
  if (f.condition) await tryOne("Any condition", lane, keywords, without("condition"), `Nothing **${f.condition}** right now.`);
  if (f.vehicleCondition) await tryOne("Any condition", lane, keywords, without("vehicleCondition"), "Nothing in that condition right now.");
  if (f.minYear != null || f.maxYear != null) await tryOne("Any year", lane, keywords, without("minYear", "maxYear"), "Nothing from those years right now.");
  if (f.model) await tryOne(`Any ${f.make ?? ""} model`.replace("  ", " "), lane, keywords, without("model"), `No **${[f.make, f.model].filter(Boolean).join(" ")}** right now.`);
  if (f.minBeds != null && f.minBeds > 1) await tryOne(`${f.minBeds - 1}+ bed`, lane, keywords, { ...f, minBeds: f.minBeds - 1 }, `No **${f.minBeds}+ bed** places here right now.`);
  if (f.transmission || f.fuel || f.body) await tryOne("Any gearbox, fuel or body", lane, keywords, without("transmission", "fuel", "body"), "Nothing with that gearbox, fuel or body right now.");
  if (f.availability) await tryOne("Any availability", lane, keywords, without("availability"), "No one is free then right now.");

  // 3. The area: the area's state, then everywhere.
  const place = f.state ? { state: f.state, city: f.city } : scope;
  const nearMe = scope.nearLat != null && !f.state;
  if (place.city) {
    await tryOne(`Anywhere in ${place.state}`, lane, keywords, { ...without("city"), state: place.state }, `Nothing in **${place.city}** right now.`, {});
  } else if (nearMe) {
    await tryOne("Anywhere", lane, keywords, without("state", "city"), `Nothing within **${scope.radiusKm} km** of you right now.`, {});
  }
  if (place.state) {
    await tryOne("Nationwide", lane, keywords, without("state", "city"), `Nothing in **${place.state}** right now.`, {});
  }

  // 4. The words: everything in this lane and filter set, whatever it's called.
  if (keywords) {
    const bare = !lane && Object.keys(f).length === 0;
    // "All apartments for rent · Lekki"; with nothing else set, just "Browse everything".
    const label = bare ? "Browse everything" : buildSummary(lane, f, "").replace(/^Showing /, "All ").replace(/\*\*/g, "");
    await tryOne(label, lane, "", f, bare ? `Nothing matches **“${keywords}”** right now.` : `Nothing matches **“${keywords}”** with these filters.`);
  }

  return { message: message ?? (out.length ? "Nothing matches all of that right now." : "Nothing matches that right now — try fewer words or a wider area."), suggestions: out.slice(0, 3) };
}
