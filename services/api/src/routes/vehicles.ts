import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import {
  BODIES,
  FUELS,
  MIN_YEAR,
  OTHER_MAKE,
  REGISTRATIONS,
  TRANSMISSIONS,
  VEHICLE_CATALOG,
  VEHICLE_CONDITIONS,
  maxYear,
} from "../data/vehicles.js";

/**
 * Phase 3 C — the Vehicles lane's reference data (13h) and price insight (13h-review,
 * 22b "Priced ₦0.4M below similar cars"). Both public: browsing needs no account.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const VehicleCatalogSchema = z
  .object({
    makes: z.array(
      z
        .object({
          make: z.string(),
          models: z.array(
            z
              .object({ name: z.string(), body: z.enum(BODIES), fuel: z.enum(FUELS).nullable() })
              .openapi("VehicleModel"),
          ),
        })
        .openapi("VehicleMake"),
    ),
    /** The make to post under when it isn't listed; its model is free text. */
    otherMake: z.string(),
    minYear: z.number().int(),
    maxYear: z.number().int(),
    transmissions: z.array(z.enum(TRANSMISSIONS)),
    fuels: z.array(z.enum(FUELS)),
    bodies: z.array(z.enum(BODIES)),
    conditions: z.array(z.enum(VEHICLE_CONDITIONS)),
    registrations: z.array(z.enum(REGISTRATIONS)),
  })
  .openapi("VehicleCatalog");

/** Fewer comparables than this and there's no verdict — a median of two cars isn't a market. */
export const MIN_COMPARABLES = 3;
/** Within ±this fraction of the median counts as "fair". */
export const FAIR_BAND = 0.1;
/** Comparables are the same make + model within ±this many model years. */
export const YEAR_SPAN = 2;

const PriceInsightSchema = z
  .object({
    comparables: z.number().int().nonnegative(),
    /** Median asking price of the comparables; null below MIN_COMPARABLES. */
    medianKobo: z.number().int().nullable(),
    /** Present when priceKobo was given and there are enough comparables. */
    verdict: z.enum(["below", "fair", "above"]).nullable(),
    /** priceKobo − median (negative = cheaper than similar cars). */
    deltaKobo: z.number().int().nullable(),
  })
  .openapi("VehiclePriceInsight");

export function registerVehicles(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/vehicles/catalog",
      summary: "Makes, models (with body/fuel prefill) and the lane's vocabularies",
      tags: ["vehicles"],
      responses: {
        200: { description: "Catalogue", content: { "application/json": { schema: VehicleCatalogSchema } } },
      },
    }),
    (c) => {
      c.header("Cache-Control", "public, max-age=3600");
      return c.json(
        {
          makes: VEHICLE_CATALOG.map((e) => ({
            make: e.make,
            models: e.models.map((m) => ({ name: m.name, body: m.body, fuel: m.fuel ?? null })),
          })),
          otherMake: OTHER_MAKE,
          minYear: MIN_YEAR,
          maxYear: maxYear(),
          transmissions: [...TRANSMISSIONS],
          fuels: [...FUELS],
          bodies: [...BODIES],
          conditions: [...VEHICLE_CONDITIONS],
          registrations: [...REGISTRATIONS],
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/vehicles/price-insight",
      summary: "How an asking price compares with active listings of the same make/model/year band",
      tags: ["vehicles"],
      request: {
        query: z.object({
          make: z.string().min(1).max(40),
          model: z.string().min(1).max(40),
          year: z.coerce.number().int(),
          priceKobo: z.coerce.number().int().nonnegative().optional(),
          /** The listing being viewed, so it isn't compared with itself. */
          excludeListingId: z.string().uuid().optional(),
        }),
      },
      responses: {
        200: { description: "Insight", content: { "application/json": { schema: PriceInsightSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { make, model, year, priceKobo, excludeListingId } = c.req.valid("query");
      const [r] = await db<{ n: number; median: string | number | null }[]>`
        select count(*)::int as n,
          percentile_cont(0.5) within group (order by price_kobo) as median
        from public.listings
        where status = 'active' and lane = 'vehicles'
          and attributes->>'make' = ${make}
          and lower(attributes->>'model') = lower(${model})
          and (attributes->>'year')::int between ${year - YEAR_SPAN} and ${year + YEAR_SPAN}
          and price_kobo > 0
          ${excludeListingId ? db`and id <> ${excludeListingId}` : db``}
      `;
      const n = r?.n ?? 0;
      const median = n >= MIN_COMPARABLES && r?.median != null ? Math.round(Number(r.median)) : null;
      let verdict: "below" | "fair" | "above" | null = null;
      let delta: number | null = null;
      if (median != null && priceKobo != null) {
        delta = priceKobo - median;
        verdict = Math.abs(delta) <= median * FAIR_BAND ? "fair" : delta < 0 ? "below" : "above";
      }
      c.header("Cache-Control", "public, max-age=300");
      return c.json({ comparables: n, medianKobo: median, verdict, deltaKobo: delta }, 200);
    },
  );
}
