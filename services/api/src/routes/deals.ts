import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { createOffer, transition, type DealRow, type DealTerms, type Sql } from "../deals/commands.js";
import { CHECKOUT_TTL_MIN, openCheckout, quote, railFor, type Rail } from "../money/checkout.js";
import { PaystackError } from "../money/paystack.js";
import { rescaleStages, stageProblem, MAX_STAGES, type StageRow } from "../deals/stages.js";
import { isBlockedEitherWay } from "../profiles/summary.js";
import {
  DealDeliverySchema,
  DeliveryChoiceSchema,
  deliveryChoiceProblem,
  feePending,
  listingDelivery,
  nextDelivery,
  principalOf,
  type DealDelivery,
} from "../deals/delivery.js";

/**
 * M3 — offers/deals + chat. Buyers open offers on listings; both parties drive the
 * negotiation through the state machine (services/api/src/deals/commands.ts). All
 * writes are service-role through here; clients only READ deals/messages (directly
 * via Realtime, gated by RLS). Money actions (pay/hand_off/…) arrive in M4+.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const CancelRefundRequestSchema = z
  .object({ /** Shown to the buyer in the deal history. */ reason: z.string().max(200).optional() })
  .openapi("CancelRefundRequest");

/** One stage of a staged quote as proposed (22c-quotebuild): what it covers + its share. */
export const StagePlanSchema = z
  .object({
    title: z.string().trim().min(1).max(60),
    amountKobo: z.number().int().positive(),
  })
  .openapi("StagePlan");

/**
 * A shortlet booking (22a-shortlet): dates (YYYY-MM-DD, Lagos; check-in from 2pm,
 * checkout by 11am) and how the price was built. Fixed when booked.
 */
const BookingTermsSchema = z
  .object({
    checkIn: z.string(),
    checkOut: z.string(),
    guests: z.number().int().positive(),
    nights: z.number().int().positive(),
    nightlyKobo: z.number().int().nonnegative(),
    cleaningKobo: z.number().int().nonnegative(),
    cautionKobo: z.number().int().nonnegative(),
  })
  .openapi("BookingTerms");

/**
 * What a deal is for, beyond a price: a service quote's terms (22c-quotecard: Service ·
 * Scope · When), or a shortlet booking's (service = the listing title). Absent on goods deals.
 */
export const DealTermsSchema = z
  .object({
    service: z.string(),
    scope: z.string().nullable().optional(),
    startsAt: z.string().nullable().optional(),
    /** A staged quote: stages summing to the price, released one by one (22c-milestone). */
    milestones: z.array(StagePlanSchema).max(MAX_STAGES).optional(),
    /** A shortlet booking: stages are [Stay, Caution deposit?]. */
    booking: BookingTermsSchema.optional(),
  })
  .openapi("DealTerms");

/**
 * A staged job's stage and where its money is (22c-milestone). "proposed" until the
 * buyer funds escrow; then held → releasing → released (or refunded). A shortlet's
 * caution deposit goes back while the booking stands: held → refunding → refunded.
 */
const DealMilestoneSchema = z
  .object({
    idx: z.number().int().positive(),
    title: z.string(),
    amountKobo: z.number().int().positive(),
    status: z.enum(["proposed", "held", "releasing", "released", "refunding", "refunded"]),
    releasedAt: z.string().optional(),
  })
  .openapi("DealMilestone");

export const DealSchema = z
  .object({
    id: z.string().uuid(),
    listingId: z.string().uuid(),
    buyerId: z.string().uuid(),
    sellerId: z.string().uuid(),
    role: z.enum(["buyer", "seller"]),
    state: z.string(),
    stateToken: z.string().uuid(),
    priceKobo: z.number().int().nonnegative(),
    qty: z.number().int().positive(),
    terms: DealTermsSchema.optional(),
    /**
     * Goods: how the item changes hands (7h-offer, 13b-delivery). priceKobo is the items;
     * a deliver fee rides on top and is part of what escrow holds (payment.principalKobo).
     */
    delivery: DealDeliverySchema.optional(),
    /** A staged job's stages with their money status (absent when unstaged). */
    milestones: z.array(DealMilestoneSchema).optional(),
    /** The buyer's price breakdown while the deal awaits payment (absent otherwise). */
    payment: z
      .object({
        rail: z.enum(["mock", "paystack"]),
        principalKobo: z.number().int(),
        buyerFeeKobo: z.number().int(),
        /** Paystack's cut, paid by the buyer (0 on the mock rail). Not refunded. */
        processingFeeKobo: z.number().int(),
        totalKobo: z.number().int(),
      })
      .openapi("PaymentQuote")
      .optional(),
    /** An open Paystack checkout (buyer, PAYMENT_PENDING): open authorizationUrl to pay. */
    checkout: z
      .object({
        reference: z.string(),
        authorizationUrl: z.string(),
        accessCode: z.string(),
        totalKobo: z.number().int(),
        processingFeeKobo: z.number().int(),
        expiresAt: z.string(),
      })
      .openapi("Checkout")
      .optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Deal");

const DealEventSchema = z
  .object({
    seq: z.number().int(),
    actor: z.enum(["BUYER", "SELLER", "ADMIN", "SYSTEM"]),
    action: z.string(),
    fromState: z.string().nullable(),
    toState: z.string(),
    priceKobo: z.number().int().nullable(),
    qty: z.number().int().nullable(),
    reason: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("DealEvent");

const DealDetailSchema = DealSchema.extend({
  events: z.array(DealEventSchema),
}).openapi("DealDetail");

const MessageSchema = z
  .object({
    id: z.number().int(),
    dealId: z.string().uuid(),
    senderId: z.string().uuid(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi("Message");

const OfferCreateSchema = z
  .object({
    /** The whole amount for the items (unit × qty) — never per unit (0008). */
    priceKobo: z.number().int().nonnegative(),
    qty: z.number().int().positive().optional(),
    /** Goods: how the buyer wants it — one of the listing's delivery modes. */
    delivery: DeliveryChoiceSchema.optional(),
  })
  .openapi("OfferCreate");

const PayRequestSchema = z
  .object({
    /**
     * The total the buyer was shown. If the deal's total has moved since (a new
     * delivery fee), the pay is refused with total_changed rather than charging more.
     */
    expectedTotalKobo: z.number().int().positive().optional(),
  })
  .openapi("PayRequest");

const DealActionSchema = z
  .object({
    action: z.enum(["counter", "accept", "decline", "withdraw", "cancel"]),
    priceKobo: z.number().int().nonnegative().optional(),
    qty: z.number().int().positive().optional(),
    /**
     * Provider counters only: re-split a service quote into stages summing to
     * priceKobo ([] drops the split). Omitted, a staged quote keeps its proportions.
     */
    milestones: z.array(StagePlanSchema).max(MAX_STAGES).optional(),
    /** Goods counters only: change how the item changes hands. Omitted, it stays as agreed. */
    delivery: DeliveryChoiceSchema.optional(),
  })
  .openapi("DealAction");

const MessageCreateSchema = z
  .object({ body: z.string().min(1).max(2000) })
  .openapi("MessageCreate");

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

type DealOut = z.infer<typeof DealSchema>;

/** Live stages when escrow holds them; the proposed plan from the terms before that. */
function milestonesOf(d: DealRow, rows: StageRow[] | undefined): DealOut["milestones"] {
  if (rows?.length) {
    return rows.map((m) => ({
      idx: m.idx,
      title: m.title,
      amountKobo: Number(m.amount_kobo),
      status: m.status,
      releasedAt: m.released_at ? iso(m.released_at) : undefined,
    }));
  }
  const plan = d.terms?.milestones;
  return plan?.length
    ? plan.map((m, i) => ({ idx: i + 1, title: m.title, amountKobo: m.amountKobo, status: "proposed" as const }))
    : undefined;
}

/** Deals as the API returns them, stages included (one query for the lot). */
async function dealsOut(db: Sql, deals: DealRow[], uid: string): Promise<DealOut[]> {
  const ids = deals.filter((d) => d.terms?.milestones?.length).map((d) => d.id);
  const rows = ids.length
    ? await db<StageRow[]>`select * from public.deal_milestones where deal_id = any(${ids}::uuid[]) order by idx`
    : [];
  // The buyer's breakdown while payment is due; the open checkout once it's pending.
  const due = deals.filter((d) => d.buyer_id === uid && (d.state === "ACCEPTED" || d.state === "PAYMENT_PENDING"));
  let myRail: Rail | undefined;
  const payments = new Map<string, NonNullable<DealOut["payment"]>>();
  const checkouts = new Map<string, NonNullable<DealOut["checkout"]>>();
  for (const d of due) {
    const rail = d.payment_provider ?? (myRail ??= await railFor(db, uid));
    payments.set(d.id, quote(rail, principalOf(d)));
  }
  // 7h-feereply: a seller who still owes a delivery fee gets their recent fees as chips.
  const owing = deals.filter((d) => d.seller_id === uid && feePending(d.delivery));
  const suggested = owing.length ? await recentFees(db, uid) : [];
  const pendingIds = due.filter((d) => d.state === "PAYMENT_PENDING" && d.payment_provider === "paystack").map((d) => d.id);
  if (pendingIds.length) {
    const open = await db<{ deal_id: string; reference: string; authorization_url: string; access_code: string; gross_kobo: string; processing_fee_kobo: string; created_at: Date }[]>`
      select distinct on (deal_id) deal_id, reference, authorization_url, access_code, gross_kobo, processing_fee_kobo, created_at
      from public.payments
      where deal_id = any(${pendingIds}::uuid[]) and status = 'initialized' and authorization_url is not null
        and created_at > now() - make_interval(mins => ${CHECKOUT_TTL_MIN - 5})
      order by deal_id, created_at desc`;
    for (const p of open) checkouts.set(p.deal_id, {
      reference: p.reference, authorizationUrl: p.authorization_url, accessCode: p.access_code,
      totalKobo: Number(p.gross_kobo), processingFeeKobo: Number(p.processing_fee_kobo),
      expiresAt: new Date(p.created_at.getTime() + CHECKOUT_TTL_MIN * 60_000).toISOString(),
    });
  }
  return deals.map((d) => ({
    ...toDeal(d, uid),
    milestones: milestonesOf(d, rows.filter((r) => r.deal_id === d.id)),
    delivery: d.delivery ? deliveryOut(d.delivery, d.seller_id === uid && feePending(d.delivery) ? suggested : undefined) : undefined,
    payment: payments.get(d.id),
    checkout: checkouts.get(d.id),
  }));
}
export const dealOut = async (db: Sql, d: DealRow, uid: string) => (await dealsOut(db, [d], uid))[0]!;

function deliveryOut(d: DealDelivery, suggestedFeesKobo?: number[]): z.infer<typeof DealDeliverySchema> {
  return {
    method: d.method,
    state: d.state,
    place: d.place,
    when: d.when,
    feeKobo: d.feeKobo ?? null,
    window: d.window ?? null,
    ...(suggestedFeesKobo ? { suggestedFeesKobo } : {}),
  };
}

/** A seller's last few distinct delivery fees, newest first — the 7h-feereply chips. */
async function recentFees(db: Sql, sellerId: string): Promise<number[]> {
  const rows = await db<{ fee: string }[]>`
    select fee from (
      select distinct on ((delivery->>'feeKobo')::bigint) (delivery->>'feeKobo')::bigint as fee, updated_at
      from public.deals
      where seller_id = ${sellerId} and delivery->>'feeKobo' is not null
      order by (delivery->>'feeKobo')::bigint, updated_at desc
    ) f order by updated_at desc limit 3
  `;
  return rows.map((r) => Number(r.fee));
}

function toDeal(d: DealRow, uid: string): DealOut {
  return {
    id: d.id,
    listingId: d.listing_id,
    buyerId: d.buyer_id,
    sellerId: d.seller_id,
    role: d.buyer_id === uid ? "buyer" : "seller",
    state: d.state,
    stateToken: d.state_token,
    priceKobo: Number(d.price_kobo),
    qty: d.qty,
    terms: d.terms ?? undefined,
    delivery: d.delivery ? deliveryOut(d.delivery) : undefined,
    createdAt: iso(d.created_at),
    updatedAt: iso(d.updated_at),
  };
}

const idem = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header("idempotency-key") ?? undefined;

export function registerDeals(app: OpenAPIHono<AuthEnv>) {
  // ── POST /listings/{id}/offers — open an offer (genesis) ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/offers",
      summary: "Open an offer on a listing",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: OfferCreateSchema } } },
      },
      responses: {
        201: { description: "Deal opened", content: { "application/json": { schema: DealSchema } } },
        400: { description: "Cannot offer on own listing", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        409: { description: "Listing unavailable, lead-gen lane, a services listing (the provider quotes first), or a shortlet (book_first)", content: { "application/json": { schema: ErrorSchema } } },
        422: { description: "Delivery choice doesn't fit the listing (delivery_method_not_offered, outside_delivery_coverage, delivery_needs_state, meet_needs_place)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [owner] = await db<{ seller_id: string }[]>`select seller_id from public.listings where id = ${id}`;
      if (owner && (await isBlockedEitherWay(db, user.sub, owner.seller_id)))
        return c.json({ error: "blocked" }, 403);
      const r = await createOffer(db, {
        listingId: id,
        buyerId: user.sub,
        priceKobo: b.priceKobo,
        qty: b.qty ?? 1,
        delivery: b.delivery,
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "delivery") return c.json({ error: r.detail }, 422);
        if (r.code === "own_listing") return c.json({ error: "cannot_offer_own_listing" }, 400);
        if (r.code === "lead_gen_lane") return c.json({ error: "lead_gen_lane" }, 409);
        if (r.code === "quote_first") return c.json({ error: "quote_first" }, 409);
        if (r.code === "book_first") return c.json({ error: "book_first" }, 409);
        return c.json({ error: "listing_unavailable" }, 409);
      }
      return c.json(toDeal(r.deal, user.sub), 201);
    },
  );

  // ── GET /deals — the caller's deals (as buyer or seller) ────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals",
      summary: "The caller's deals",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Deals", content: { "application/json": { schema: z.array(DealSchema) } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<DealRow[]>`
        select * from public.deals
        where buyer_id = ${user.sub} or seller_id = ${user.sub}
        order by updated_at desc
      `;
      return c.json(await dealsOut(db, rows, user.sub), 200);
    },
  );

  // ── GET /deals/{id} — a deal + its event log (party only) ───────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}",
      summary: "A deal with its event log",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Deal detail", content: { "application/json": { schema: DealDetailSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<DealRow[]>`select * from public.deals where id = ${id}`;
      if (!deal || (deal.buyer_id !== user.sub && deal.seller_id !== user.sub))
        return c.json({ error: "not_found" }, 404);
      const events = await db<
        {
          seq: number;
          actor: "BUYER" | "SELLER" | "ADMIN" | "SYSTEM";
          action: string;
          from_state: string | null;
          to_state: string;
          price_kobo: string | number | null;
          qty: number | null;
          reason: string | null;
          created_at: string | Date;
        }[]
      >`
        select seq, actor, action, from_state, to_state, price_kobo, qty, reason, created_at
        from public.deal_events where deal_id = ${id} order by seq
      `;
      return c.json(
        {
          ...(await dealOut(db, deal, user.sub)),
          events: events.map((e) => ({
            seq: e.seq,
            actor: e.actor,
            action: e.action,
            fromState: e.from_state,
            toState: e.to_state,
            priceKobo: e.price_kobo == null ? null : Number(e.price_kobo),
            qty: e.qty,
            reason: e.reason,
            createdAt: iso(e.created_at),
          })),
        },
        200,
      );
    },
  );

  // ── POST /deals/{id}/actions — drive the negotiation ────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/actions",
      summary: "Apply a negotiation action (counter/accept/decline/withdraw/cancel)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DealActionSchema } } },
      },
      responses: {
        200: { description: "Applied", content: { "application/json": { schema: DealSchema } } },
        400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Illegal transition or conflict", content: { "application/json": { schema: ErrorSchema } } },
        422: { description: "Stages don't fit the price", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");

      const [deal] = await db<
        { buyer_id: string; seller_id: string; terms: DealTerms | null; delivery: DealDelivery | null; lane: string; attributes: Record<string, unknown> | null; listing_state: string | null }[]
      >`
        select d.buyer_id, d.seller_id, d.terms, d.delivery, l.lane, l.attributes, l.state as listing_state
        from public.deals d join public.listings l on l.id = d.listing_id where d.id = ${id}
      `;
      if (!deal || (deal.buyer_id !== user.sub && deal.seller_id !== user.sub))
        return c.json({ error: "not_found" }, 404);
      if (b.action === "counter" && b.priceKobo == null)
        return c.json({ error: "counter_requires_price" }, 400);

      // A counter may change how the item changes hands (goods only). A new method or
      // destination drops the pinned fee — it was quoted for the old one.
      let delivery: DealDelivery | undefined;
      if (b.delivery) {
        if (b.action !== "counter" || deal.lane !== "goods") return c.json({ error: "delivery_only_on_goods_counter" }, 400);
        const bad = deliveryChoiceProblem(b.delivery, listingDelivery(deal.attributes as never, deal.listing_state));
        if (bad) return c.json({ error: bad }, 422);
        delivery = nextDelivery(deal.delivery, b.delivery);
      }

      const actor = deal.buyer_id === user.sub ? "BUYER" : "SELLER";

      // A counter on a service quote re-plans its stages: the provider may re-split
      // (or drop the split); otherwise the stages keep their proportions at the new
      // price. Only a provider decides how the work is staged.
      let terms: DealTerms | undefined;
      if (b.milestones && (b.action !== "counter" || actor !== "SELLER" || !deal.terms))
        return c.json({ error: "only_provider_counter_stages" }, 400);
      if (b.action === "counter" && deal.terms) {
        const plan = b.milestones ?? deal.terms.milestones ?? [];
        if (b.milestones?.length) {
          const bad = stageProblem(b.milestones, b.priceKobo!);
          if (bad) return c.json({ error: bad }, 422);
          terms = { ...deal.terms, milestones: b.milestones };
        } else if (plan.length && !b.milestones) {
          const scaled = rescaleStages(plan, b.priceKobo!);
          if (!scaled) return c.json({ error: "price_too_low_for_stages" }, 422);
          terms = { ...deal.terms, milestones: scaled };
        } else if (b.milestones) {
          terms = { ...deal.terms, milestones: undefined };
        }
      }
      const r = await transition(db, {
        dealId: id,
        actor,
        actorId: user.sub,
        action: b.action,
        priceKobo: b.priceKobo,
        qty: b.qty,
        terms,
        delivery,
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        const err =
          r.code === "illegal"
            ? "illegal_transition"
            : r.code === "idempotency_reuse"
              ? "idempotency_key_reuse"
              : "conflict";
        return c.json({ error: err }, 409);
      }
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );

  // ── POST /deals/{id}/pay — buyer pays an accepted offer (M4, 3H) ─────────────
  // Moves ACCEPTED → PAYMENT_PENDING. Paystack: opens a checkout (returned as
  // `checkout`; the app opens its authorizationUrl) and Paystack's webhook confirms →
  // PAID_IN_ESCROW. Calling again while pending returns the open checkout (or a fresh
  // one). Mock rail (test accounts / no key): enqueues the mock hold, as before.
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/pay",
      summary: "Pay an accepted offer (opens the escrow hold)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: PayRequestSchema } }, required: false },
      },
      responses: {
        200: { description: "Payment initiated", content: { "application/json": { schema: DealSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        502: { description: "Could not open a Paystack checkout (deal left ACCEPTED)", content: { "application/json": { schema: ErrorSchema } } },
        409: { description: "Not payable in this state; delivery_fee_pending (the seller hasn't set the delivery fee); total_changed (the total moved since it was shown)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<
        { buyer_id: string; state: string; payment_provider: string | null; delivery: DealDelivery | null; principal_kobo: string }[]
      >`
        select buyer_id, state, payment_provider, delivery, principal_kobo from public.deals where id = ${id}
      `;
      // Only the buyer pays (a seller sees the same 404 as a stranger).
      if (!deal || deal.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);
      const expected = (await c.req.json().catch(() => ({}))) as { expectedTotalKobo?: unknown };

      if (deal.state === "ACCEPTED") {
        // 13b-nodelivery: the seller delivers but no fee is agreed — escrow can't total.
        if (feePending(deal.delivery)) return c.json({ error: "delivery_fee_pending" }, 409);
        // The buyer pays what they saw, or nothing: a fee pinned since then must be seen first.
        if (typeof expected.expectedTotalKobo === "number") {
          // The rail pay is about to pick (an ACCEPTED deal is re-railed below).
          if (quote(await railFor(db, user.sub), Number(deal.principal_kobo)).totalKobo !== expected.expectedTotalKobo)
            return c.json({ error: "total_changed" }, 409);
        }
      }

      const checkoutFor = async () => {
        try {
          return { ok: true as const, checkout: await openCheckout(db, id, user.sub) };
        } catch (e) {
          console.error("[pay] checkout failed:", e instanceof PaystackError ? `${e.status} ${e.message}` : e);
          return { ok: false as const };
        }
      };

      // Already pending on Paystack (the buyer closed the checkout): hand it back.
      if (deal.state === "PAYMENT_PENDING" && deal.payment_provider === "paystack") {
        const co = await checkoutFor();
        if (!co.ok) return c.json({ error: "payment_unavailable" }, 502);
        const [row] = await db<DealRow[]>`select * from public.deals where id = ${id}`;
        return c.json({ ...(await dealOut(db, row!, user.sub)), checkout: co.checkout }, 200);
      }

      // Choose the rail before the transition, so the pay effect knows whether to
      // enqueue a mock hold. Only an ACCEPTED deal is re-railed.
      const rail = await railFor(db, user.sub);
      await db`update public.deals set payment_provider = ${rail} where id = ${id} and state = 'ACCEPTED'`;

      const r = await transition(db, {
        dealId: id,
        actor: "BUYER",
        actorId: user.sub,
        action: "pay",
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_payable" : "conflict" }, 409);
      }
      if (r.deal.payment_provider !== "paystack") return c.json(await dealOut(db, r.deal, user.sub), 200);

      const co = await checkoutFor();
      if (!co.ok) {
        // Couldn't open a checkout: put the deal back so the buyer can try again.
        await transition(db, { dealId: id, actor: "SYSTEM", action: "payment_failed", idempotencyKey: `checkout-failed:${r.deal.state_token}` });
        return c.json({ error: "payment_unavailable" }, 502);
      }
      const [row] = await db<DealRow[]>`select * from public.deals where id = ${id}`;
      return c.json({ ...(await dealOut(db, row!, user.sub)), checkout: co.checkout }, 200);
    },
  );

  // ── POST /deals/{id}/handoff — seller hands off a paid deal (M5) ─────────────
  // PAID_IN_ESCROW → HANDED_OFF. Starts the 48h auto-release clock. Seller only.
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/handoff",
      summary: "Seller marks the item handed off",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Handed off", content: { "application/json": { schema: DealSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not in a handoff-able state", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);

      const r = await transition(db, {
        dealId: id,
        actor: "SELLER",
        actorId: user.sub,
        action: "hand_off",
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "illegal_transition" : "conflict" }, 409);
      }
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );

  // ── POST /deals/{id}/cancel-refund — seller can't fulfil a paid deal ────────
  // PAID_IN_ESCROW → REFUNDED (cancel_refund): the buyer gets back what the hold
  // booked (principal + escrow fee; the processing fee is the provider's). Only before
  // hand-off — after it, the buyer has the item and a refund goes through a dispute.
  // Stock isn't put back: a seller who can't fulfil usually no longer has the item.
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/cancel-refund",
      summary: "Seller cancels a paid deal before hand-off and refunds the buyer",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { required: false, content: { "application/json": { schema: CancelRefundRequestSchema } } },
      },
      responses: {
        200: { description: "Cancelled; refund on its way", content: { "application/json": { schema: DealSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not cancellable now (not paid, or already handed off)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const body = (c.req.valid("json") as z.infer<typeof CancelRefundRequestSchema> | undefined) ?? {};
      const [deal] = await db<{ seller_id: string }[]>`select seller_id from public.deals where id = ${id}`;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);

      const r = await transition(db, {
        dealId: id,
        actor: "SELLER",
        actorId: user.sub,
        action: "cancel_refund",
        reason: body.reason?.trim().slice(0, 200) || "seller_cancelled",
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "illegal_transition" : "conflict" }, 409);
      }
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );

  // ── POST /deals/{id}/confirm — buyer confirms receipt → release (M5) ────────
  // HANDED_OFF → COMPLETED, enqueuing the escrow release (settles via webhook).
  // Buyer only; the 48h timer does this automatically if the buyer stays silent.
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/confirm",
      summary: "Buyer confirms receipt (releases funds to the seller)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Confirmed — release initiated", content: { "application/json": { schema: DealSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not in a confirmable state", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || deal.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);

      const r = await transition(db, {
        dealId: id,
        actor: "BUYER",
        actorId: user.sub,
        action: "confirm_receipt",
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "illegal_transition" : "conflict" }, 409);
      }
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );

  // ── GET /deals/{id}/messages ────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}/messages",
      summary: "Chat messages for a deal (party only)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Messages", content: { "application/json": { schema: z.array(MessageSchema) } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || (deal.buyer_id !== user.sub && deal.seller_id !== user.sub))
        return c.json({ error: "not_found" }, 404);
      const rows = await db<
        { id: number | string; deal_id: string | null; sender_id: string; body: string; created_at: string | Date }[]
      >`
        -- The deal's whole conversation, including chat from before the offer.
        select m.id, m.deal_id, m.sender_id, m.body, m.created_at
        from public.messages m
        join public.conversations cv on cv.id = m.conversation_id
        join public.deals d on d.listing_id = cv.listing_id and d.buyer_id = cv.buyer_id
        where d.id = ${id} order by m.created_at, m.id
      `;
      return c.json(
        rows.map((m) => ({
          id: Number(m.id), // bigint arrives as a string
          // Pre-offer messages carry no deal; report them under this deal's thread.
          dealId: m.deal_id ?? id,
          senderId: m.sender_id,
          body: m.body,
          createdAt: iso(m.created_at),
        })),
        200,
      );
    },
  );

  // ── POST /deals/{id}/messages ───────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/messages",
      summary: "Send a chat message (party only)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: MessageCreateSchema } } },
      },
      responses: {
        201: { description: "Sent", content: { "application/json": { schema: MessageSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { body } = c.req.valid("json");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || (deal.buyer_id !== user.sub && deal.seller_id !== user.sub))
        return c.json({ error: "not_found" }, 404);
      if (await isBlockedEitherWay(db, deal.buyer_id, deal.seller_id)) return c.json({ error: "blocked" }, 403);
      // The messages_link trigger files it under the deal's conversation.
      const [m] = await db<
        { id: number | string; deal_id: string; sender_id: string; body: string; created_at: string | Date }[]
      >`
        insert into public.messages (deal_id, sender_id, body)
        values (${id}, ${user.sub}, ${body})
        returning id, deal_id, sender_id, body, created_at
      `;
      return c.json(
        { id: Number(m!.id), dealId: m!.deal_id, senderId: m!.sender_id, body: m!.body, createdAt: iso(m!.created_at) },
        201,
      );
    },
  );
}
