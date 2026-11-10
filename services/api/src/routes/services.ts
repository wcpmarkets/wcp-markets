import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { createQuote, type Sql } from "../deals/commands.js";
import { AVAILABILITY, COVERAGE_KM, SERVICE_CATALOG } from "../data/services.js";
import { isState, areaCentre } from "../data/ng-regions.js";
import { UserSummarySchema, isBlockedEitherWay, userSummaries } from "../profiles/summary.js";

/**
 * Phase 3 D — Services: quote-first (design 22c, 22c-quote, 22c-inbox, 22c-quotebuild).
 *
 * The buyer sends a structured brief (a quote request) into the (listing, buyer)
 * thread; the provider answers with a price, which opens a deal in
 * COUNTERED_BY_SELLER. From there the ordinary machine runs: accept or counter, pay
 * into escrow, provider marks the job done (hand_off), buyer confirms and releases.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ServiceCatalogSchema = z
  .object({
    groups: z.array(
      z.object({ group: z.string(), types: z.array(z.string()) }).openapi("ServiceGroup"),
    ),
    availability: z.array(z.enum(AVAILABILITY)),
    coverageKm: z.array(z.number().int()),
  })
  .openapi("ServiceCatalog");

/** Where a request sits for the provider (22c-inbox tabs), derived from its latest deal. */
const STAGES = ["new", "quoted", "scheduled", "done"] as const;
type Stage = (typeof STAGES)[number];

const QuoteRequestSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    listingId: z.string().uuid(),
    listingTitle: z.string(),
    buyer: UserSummarySchema,
    seller: UserSummarySchema,
    service: z.string(),
    description: z.string(),
    location: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    preferred: z.string().nullable(),
    status: z.enum(["open", "closed"]),
    stage: z.enum(STAGES),
    dealId: z.string().uuid().nullable(),
    dealState: z.string().nullable(),
    quotedKobo: z.number().int().nullable(),
    startsAt: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("QuoteRequest");

const QuoteRequestCreateSchema = z
  .object({
    /** Which line of the rate card (or the provider's service in general). */
    service: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(2000),
    /** Canonical ng-regions pair, when the buyer picks one. */
    state: z.string().max(64).optional(),
    city: z.string().max(64).optional(),
    location: z.string().trim().max(120).optional(),
    /** Free text: "Sat AM", "today if possible". */
    preferred: z.string().trim().max(80).optional(),
  })
  .openapi("QuoteRequestCreate");

const QuoteCreateSchema = z
  .object({
    priceKobo: z.number().int().positive(),
    scope: z.string().trim().max(200).optional(),
    startsAt: z.string().datetime({ offset: true }).optional(),
  })
  .openapi("QuoteCreate");

const QuoteRequestPageSchema = z
  .object({
    items: z.array(QuoteRequestSchema),
    counts: z.object({
      all: z.number().int(),
      new: z.number().int(),
      quoted: z.number().int(),
      scheduled: z.number().int(),
    }).openapi("QuoteRequestCounts"),
  })
  .openapi("QuoteRequestPage");

const NEGOTIATING = ["OFFERED", "COUNTERED_BY_SELLER", "COUNTERED_BY_BUYER", "ACCEPTED"];
const IN_ESCROW = ["PAYMENT_PENDING", "PAID_IN_ESCROW", "HANDED_OFF", "DISPUTED", "DISPUTED_RESPONDED"];
const FINISHED = ["COMPLETED", "REFUNDED"];

function stageOf(dealState: string | null): Stage {
  if (dealState && NEGOTIATING.includes(dealState)) return "quoted";
  if (dealState && IN_ESCROW.includes(dealState)) return "scheduled";
  if (dealState && FINISHED.includes(dealState)) return "done";
  return "new"; // none yet, or the last quote lapsed / was declined → quote again
}

type ReqRow = {
  id: string;
  conversation_id: string;
  listing_id: string;
  title: string;
  buyer_id: string;
  seller_id: string;
  service: string;
  description: string;
  location: string | null;
  state: string | null;
  city: string | null;
  preferred: string | null;
  status: "open" | "closed";
  deal_id: string | null;
  deal_state: string | null;
  deal_price: string | number | null;
  deal_starts: string | null;
  created_at: string | Date;
};

const iso = (v: string | Date): string => new Date(v).toISOString();

/** Requests with their latest deal on the same (listing, buyer) — the stage comes from it. */
function reqQuery(db: Sql) {
  return db`
    select q.id, q.conversation_id, q.listing_id, l.title, q.buyer_id, q.seller_id, q.service,
      q.description, q.location, q.state, q.city, q.preferred, q.status, q.created_at,
      d.id as deal_id, d.state as deal_state, d.price_kobo as deal_price,
      d.terms->>'startsAt' as deal_starts
    from public.quote_requests q
    join public.listings l on l.id = q.listing_id
    left join public.deals d on d.id = q.deal_id
  `;
}

async function toRequests(db: Sql, rows: ReqRow[]) {
  const people = await userSummaries(db, rows.flatMap((r) => [r.buyer_id, r.seller_id]));
  return rows.map((r) => ({
    id: r.id,
    conversationId: r.conversation_id,
    listingId: r.listing_id,
    listingTitle: r.title,
    buyer: people.get(r.buyer_id)!,
    seller: people.get(r.seller_id)!,
    service: r.service,
    description: r.description,
    location: r.location,
    state: r.state,
    city: r.city,
    preferred: r.preferred,
    status: r.status,
    stage: stageOf(r.deal_state),
    dealId: r.deal_id,
    dealState: r.deal_state,
    quotedKobo: r.deal_price != null ? Number(r.deal_price) : null,
    startsAt: r.deal_starts ? iso(r.deal_starts) : null,
    createdAt: iso(r.created_at),
  }));
}

export type QuoteRequestOut = Awaited<ReturnType<typeof toRequests>>[number];
export { QuoteRequestSchema };

/** The thread's current request (latest open one), for the conversation payload. */
export async function conversationRequests(db: Sql, conversationIds: string[]) {
  const out = new Map<string, QuoteRequestOut>();
  if (!conversationIds.length) return out;
  const rows = await db<ReqRow[]>`
    select * from (${reqQuery(db)}) x
    where x.conversation_id = any(${conversationIds}::uuid[]) and x.status = 'open'
  `;
  for (const r of await toRequests(db, rows)) out.set(r.conversationId, r);
  return out;
}

export function registerServices(app: OpenAPIHono<AuthEnv>) {
  // ── GET /services/catalog — groups, types, coverage and availability options ─
  app.openapi(
    createRoute({
      method: "get",
      path: "/services/catalog",
      summary: "Service groups and types, coverage rings and availability flags (13i)",
      tags: ["services"],
      responses: {
        200: { description: "Catalogue", content: { "application/json": { schema: ServiceCatalogSchema } } },
      },
    }),
    (c) =>
      c.json(
        {
          groups: SERVICE_CATALOG.map((g) => ({ group: g.group, types: [...g.types] })),
          availability: [...AVAILABILITY],
          coverageKm: [...COVERAGE_KM],
        },
        200,
      ),
  );

  // ── POST /listings/{id}/quote-requests — buyer sends a brief (22c-quote) ────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/quote-requests",
      summary: "Request a quote from a service provider; replaces the thread's open request",
      tags: ["services"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "quotereq", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: QuoteRequestCreateSchema } } },
      },
      responses: {
        201: { description: "Sent", content: { "application/json": { schema: QuoteRequestSchema } } },
        400: { description: "Own listing", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        409: {
          description: "Not a live services listing, or a quote is live in this thread (quote_live)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        422: { description: "Unknown area", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      if (b.state && !isState(b.state)) return c.json({ error: "unknown_state" }, 422);
      if (b.city && (!b.state || !areaCentre(b.state, b.city))) return c.json({ error: "unknown_city" }, 422);

      const [listing] = await db<{ seller_id: string; lane: string; status: string }[]>`
        select seller_id, lane, status from public.listings where id = ${id}
      `;
      if (!listing) return c.json({ error: "not_found" }, 404);
      if (listing.lane !== "services" || listing.status !== "active") return c.json({ error: "not_a_live_service" }, 409);
      if (listing.seller_id === user.sub) return c.json({ error: "own_listing" }, 400);
      if (await isBlockedEitherWay(db, user.sub, listing.seller_id)) return c.json({ error: "blocked" }, 403);

      const result = await db.begin(async (tx) => {
        const t = tx as unknown as Sql;
        await t`
          insert into public.conversations (listing_id, buyer_id, seller_id)
          values (${id}, ${user.sub}, ${listing.seller_id})
          on conflict (listing_id, buyer_id) do nothing
        `;
        const [conv] = await t<{ id: string }[]>`
          select id from public.conversations where listing_id = ${id} and buyer_id = ${user.sub} for update
        `;
        // While a quote is live (or the job is in escrow) the thread is about THAT
        // price: answer or withdraw it first. A second brief would need a second
        // deal on one (listing, buyer), which the one-active-deal rule forbids.
        const [busy] = await t`
          select 1 from public.deals
          where listing_id = ${id} and buyer_id = ${user.sub}
            and state <> all (public.deal_terminal_states())
        `;
        if (busy) return null;
        await t`
          update public.quote_requests set status = 'closed'
          where conversation_id = ${conv!.id} and status = 'open'
        `;
        const [row] = await t<{ id: string }[]>`
          insert into public.quote_requests
            (conversation_id, listing_id, buyer_id, seller_id, service, description, location, state, city, preferred)
          values (${conv!.id}, ${id}, ${user.sub}, ${listing.seller_id}, ${b.service}, ${b.description},
                  ${b.location ?? null}, ${b.state ?? null}, ${b.city ?? null}, ${b.preferred ?? null})
          returning id
        `;
        await t`update public.conversations set last_message_at = now() where id = ${conv!.id}`;
        return row!.id;
      });
      if (!result) return c.json({ error: "quote_live" }, 409);
      const rows = await db<ReqRow[]>`select * from (${reqQuery(db)}) x where x.id = ${result}`;
      return c.json((await toRequests(db, rows))[0]!, 201);
    },
  );

  // ── GET /quote-requests — the provider's request inbox (22c-inbox) ──────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/quote-requests",
      summary: "Quote requests sent to me as a provider, newest first, with New/Quoted/Scheduled counts",
      tags: ["services"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        query: z.object({
          stage: z.enum(STAGES).optional(),
          limit: z.coerce.number().int().min(1).max(100).optional(),
        }),
      },
      responses: {
        200: { description: "Requests", content: { "application/json": { schema: QuoteRequestPageSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { stage, limit } = c.req.valid("query");
      // Open requests, plus closed ones whose job went ahead (they're still "Scheduled"
      // or "done" for the provider). Blocked buyers drop out.
      const rows = await db<ReqRow[]>`
        select * from (${reqQuery(db)}) x
        where x.seller_id = ${user.sub}
          and (x.status = 'open' or x.deal_state is not null)
          and not exists (select 1 from public.blocks b
            where (b.blocker_id = x.buyer_id and b.blocked_id = x.seller_id)
               or (b.blocker_id = x.seller_id and b.blocked_id = x.buyer_id))
        order by x.created_at desc
        limit 200
      `;
      const all = await toRequests(db, rows);
      // A superseded brief that never got a quote is noise — the thread's newer one stands.
      const live = all.filter((r) => r.status === "open" || r.stage !== "new");
      const counts = {
        all: live.filter((r) => r.stage !== "done").length,
        new: live.filter((r) => r.stage === "new").length,
        quoted: live.filter((r) => r.stage === "quoted").length,
        scheduled: live.filter((r) => r.stage === "scheduled").length,
      };
      const items = (stage ? live.filter((r) => r.stage === stage) : live).slice(0, limit ?? 50);
      return c.json({ items, counts }, 200);
    },
  );

  // ── POST /quote-requests/{id}/quote — provider sends the price (22c-quotebuild) ─
  app.openapi(
    createRoute({
      method: "post",
      path: "/quote-requests/{id}/quote",
      summary: "Answer a quote request with a price (opens a deal awaiting the buyer)",
      tags: ["services"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: QuoteCreateSchema } } },
      },
      responses: {
        201: { description: "Quoted", content: { "application/json": { schema: QuoteRequestSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        409: {
          description: "Request closed, listing unavailable, or a quote is already live (counter it instead)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        422: { description: "Start date in the past", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      if (b.startsAt && new Date(b.startsAt).getTime() < Date.now() - 3_600_000) {
        return c.json({ error: "starts_in_past" }, 422);
      }
      const [req] = await db<{ buyer_id: string; service: string }[]>`
        select buyer_id, service from public.quote_requests where id = ${id} and seller_id = ${user.sub}
      `;
      if (!req) return c.json({ error: "not_found" }, 404);
      if (await isBlockedEitherWay(db, user.sub, req.buyer_id)) return c.json({ error: "blocked" }, 403);

      const r = await createQuote(db, {
        requestId: id,
        sellerId: user.sub,
        priceKobo: b.priceKobo,
        terms: { service: req.service, scope: b.scope ?? null, startsAt: b.startsAt ?? null },
        idempotencyKey: c.req.header("idempotency-key") ?? undefined,
      });
      if (!r.ok) {
        if (r.code === "request_not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code }, 409);
      }
      const rows = await db<ReqRow[]>`select * from (${reqQuery(db)}) x where x.id = ${id}`;
      return c.json((await toRequests(db, rows))[0]!, 201);
    },
  );
}
