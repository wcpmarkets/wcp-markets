import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { createBooking, transition, type DealRow, type DealTerms } from "../deals/commands.js";
import { cancellationSplit } from "../deals/effects.js";
import { bookingRoles, type StageRow } from "../deals/stages.js";
import { ownedPaths, PhotoPathsSchema } from "./attachments.js";
import { isBlockedEitherWay } from "../profiles/summary.js";

/**
 * Phase 3 E — Property shortlets (designs 13g-shortlet, 22a-shortlet, -booked, -host).
 *
 * A guest books dates (instant — no host approval) and pays the stay plus a caution
 * deposit into escrow. The stay releases to the host at checkout; the deposit goes
 * back to the guest 48h later unless the host claims it, in which case an admin
 * decides (the dispute queue). A problem during the stay is an ordinary dispute.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");

const BookingCreateSchema = z
  .object({
    checkIn: DateSchema,
    checkOut: DateSchema,
    guests: z.number().int().min(1).max(20),
  })
  .openapi("BookingCreate");

const BookingCreatedSchema = z
  .object({ dealId: z.string().uuid(), conversationId: z.string().uuid() })
  .openapi("BookingCreated");

const DepositClaimedSchema = z.object({ dealId: z.string().uuid() }).openapi("DepositClaimed");

const BookedRangeSchema = z
  .object({ checkIn: DateSchema, checkOut: DateSchema })
  .openapi("BookedRange");

const AvailabilitySchema = z
  .object({
    /** Nights already taken, as [checkIn, checkOut) — a checkout day is free to check in. */
    booked: z.array(BookedRangeSchema),
  })
  .openapi("Availability");

const DepositClaimSchema = z
  .object({
    reason: z.string().trim().min(1).max(2000),
    evidence: z.string().max(4000).optional(),
    /** Photos of the damage (POST /attachments first). */
    photoPaths: PhotoPathsSchema.optional(),
  })
  .openapi("DepositClaim");

const CancellationQuoteSchema = z
  .object({
    /** Whether the guest can still cancel (paid, before check-in). */
    cancellable: z.boolean(),
    /** By notice: 7+ days → full_refund, 2–7 days → half, under 48h → no_refund (of the nightly total). */
    tier: z.enum(["full_refund", "half", "no_refund"]),
    hoursToCheckIn: z.number(),
    /** Back to the guest: the unreleased stay, cleaning and the deposit (WCP keeps its fee). */
    refundKobo: z.number().int(),
    /** Kept by the host, before WCP's 2%. */
    hostKobo: z.number().int(),
  })
  .openapi("CancellationQuote");

const BookingCancelledSchema = z
  .object({ dealId: z.string().uuid(), tier: z.enum(["full_refund", "half", "no_refund"]), refundKobo: z.number().int(), hostKobo: z.number().int() })
  .openapi("BookingCancelled");

/** Booking window: from today (Lagos) up to a year ahead; stays of up to 30 nights. */
const MAX_AHEAD_DAYS = 365;
const MAX_NIGHTS = 30;
const DAY_MS = 86_400_000;
/** Today's date in Lagos (UTC+1, no DST) as YYYY-MM-DD. */
const lagosToday = () => new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
const validDate = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().startsWith(d);

const idem = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header("idempotency-key") ?? undefined;

export function registerBookings(app: OpenAPIHono<AuthEnv>) {
  // ── POST /listings/{id}/bookings — a guest books dates (22a-shortlet) ────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/bookings",
      summary: "Book shortlet dates (instant book); then pay the deal into escrow",
      tags: ["bookings"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "booking", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: BookingCreateSchema } } },
      },
      responses: {
        201: { description: "Booked — awaiting payment", content: { "application/json": { schema: BookingCreatedSchema } } },
        400: { description: "Own listing", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        409: {
          description: "Not a live shortlet, dates taken (dates_unavailable), or a booking here is already in progress (deal_active)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        422: {
          description: "Bad dates (invalid_dates, past_date, too_far_ahead, stay_too_long), min_nights, too_many_guests",
          content: { "application/json": { schema: ErrorSchema } },
        },
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

      if (!validDate(b.checkIn) || !validDate(b.checkOut) || b.checkOut <= b.checkIn) {
        return c.json({ error: "invalid_dates" }, 422);
      }
      const today = lagosToday();
      if (b.checkIn < today) return c.json({ error: "past_date" }, 422);
      if (Date.parse(b.checkIn) - Date.parse(today) > MAX_AHEAD_DAYS * DAY_MS) return c.json({ error: "too_far_ahead" }, 422);
      if (Date.parse(b.checkOut) - Date.parse(b.checkIn) > MAX_NIGHTS * DAY_MS) return c.json({ error: "stay_too_long" }, 422);

      const [owner] = await db<{ seller_id: string }[]>`select seller_id from public.listings where id = ${id}`;
      if (owner && (await isBlockedEitherWay(db, user.sub, owner.seller_id))) return c.json({ error: "blocked" }, 403);

      const r = await createBooking(db, {
        listingId: id,
        buyerId: user.sub,
        checkIn: b.checkIn,
        checkOut: b.checkOut,
        guests: b.guests,
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "own_listing") return c.json({ error: "cannot_book_own_listing" }, 400);
        if (r.code === "min_nights" || r.code === "too_many_guests") return c.json({ error: r.code }, 422);
        return c.json({ error: r.code }, 409);
      }
      return c.json({ dealId: r.deal.id, conversationId: r.conversationId }, 201);
    },
  );

  // ── GET /listings/{id}/availability — which nights are taken (public) ────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/{id}/availability",
      summary: "A shortlet's booked nights from today on (dates only — never who)",
      tags: ["bookings"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Booked ranges", content: { "application/json": { schema: AvailabilitySchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const rows = await db<{ check_in: string; check_out: string }[]>`
        select to_char(check_in, 'YYYY-MM-DD') as check_in, to_char(check_out, 'YYYY-MM-DD') as check_out
        from public.bookings
        where listing_id = ${id} and active and check_out > ${lagosToday()}::date
        order by check_in
      `;
      return c.json({ booked: rows.map((r) => ({ checkIn: r.check_in, checkOut: r.check_out })) }, 200);
    },
  );

  // ── POST /deals/{id}/claim-deposit — host claims the caution deposit ─────────
  // Within the 48h after checkout. Freezes the deposit; an admin decides (resolve:
  // release = the host keeps it, refund = it goes back to the guest).
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/claim-deposit",
      summary: "Host claims a shortlet's caution deposit for damage (admin decides)",
      tags: ["bookings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DepositClaimSchema } } },
      },
      responses: {
        200: { description: "Claim opened", content: { "application/json": { schema: DepositClaimedSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: {
          description: "Not claimable: outside the window after checkout, or no deposit held (no_deposit)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        422: { description: "A photo that isn't yours (bad_photo)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [deal] = await db<{ seller_id: string; terms: DealTerms | null }[]>`select seller_id, terms from public.deals where id = ${id}`;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);
      const photos = ownedPaths(user.sub, b.photoPaths);
      if (!photos) return c.json({ error: "bad_photo" }, 422);
      // The deposit is the booking's last stage when one was taken (stages.ts bookingPlan).
      const depositIdx = deal.terms?.booking ? bookingRoles(deal.terms.booking).deposit : null;
      const [deposit] = depositIdx == null ? [] : await db<{ status: string }[]>`
        select status from public.deal_milestones where deal_id = ${id} and idx = ${depositIdx}
      `;
      if (deposit?.status !== "held") return c.json({ error: "no_deposit" }, 409);

      const r = await transition(db, {
        dealId: id,
        actor: "SELLER",
        actorId: user.sub,
        action: "claim_deposit",
        reason: b.reason.slice(0, 200),
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_claimable" : "conflict" }, 409);
      }
      // The support case: the host's claim is the case, already awaiting an admin.
      await db`
        insert into public.dispute_cases (deal_id, opened_by, reason, seller_evidence, seller_photo_paths, status, responded_at)
        values (${id}, ${user.sub}, ${b.reason}, ${b.evidence ?? null}, ${photos}, 'responded', now())
        on conflict (deal_id) do update
          set opened_by = excluded.opened_by, reason = excluded.reason, seller_evidence = excluded.seller_evidence,
              seller_photo_paths = excluded.seller_photo_paths,
              status = 'responded', resolution = null, resolved_by = null, resolved_at = null, responded_at = now()
      `;
      return c.json({ dealId: id }, 200);
    },
  );

  // ── Guest cancellation (tiered by notice) ───────────────────────────────────
  // GET previews what cancelling now would return, so the app can say it before the
  // guest commits; POST does it. Both compute the split from the same function the
  // effect uses (effects.ts cancellationSplit), at the moment of asking.
  const loadForCancel = async (db: NonNullable<Awaited<ReturnType<typeof getDb>>>, id: string, userId: string) => {
    const [deal] = await db<DealRow[]>`select * from public.deals where id = ${id}`;
    if (!deal || deal.buyer_id !== userId || !deal.terms?.booking) return null;
    return { deal, stages: await db<StageRow[]>`select * from public.deal_milestones where deal_id = ${id} order by idx` };
  };

  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}/cancellation",
      summary: "Preview what a guest gets back by cancelling a paid stay now",
      tags: ["bookings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "The split if cancelled now", content: { "application/json": { schema: CancellationQuoteSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not your booking" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const got = await loadForCancel(db, c.req.valid("param").id, user.sub);
      if (!got) return c.json({ error: "not_found" }, 404);
      const s = cancellationSplit(got.deal, got.stages);
      const cancellable = got.deal.state === "PAID_IN_ESCROW" && s.hoursToCheckIn > 0;
      return c.json(
        { cancellable, tier: s.tier, hoursToCheckIn: Math.round(s.hoursToCheckIn * 10) / 10, refundKobo: s.refundKobo, hostKobo: s.hostKobo },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/cancel-booking",
      summary: "Guest cancels a paid stay before check-in (refund tiered by notice)",
      tags: ["bookings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Cancelled", content: { "application/json": { schema: BookingCancelledSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not your booking" },
        409: {
          description: "Not cancellable: unpaid, already checked in (report a problem instead), or already over (not_cancellable)",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const got = await loadForCancel(db, id, user.sub);
      if (!got) return c.json({ error: "not_found" }, 404);
      // The split reported is the one the effect applies (same instant, give or take
      // the tx): the effect recomputes it under the deal lock.
      const s = cancellationSplit(got.deal, got.stages);
      const r = await transition(db, { dealId: id, actor: "BUYER", actorId: user.sub, action: "cancel_booking", idempotencyKey: idem(c) });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_cancellable" : "conflict" }, 409);
      }
      return c.json({ dealId: id, tier: s.tier, refundKobo: s.refundKobo, hostKobo: s.hostKobo }, 200);
    },
  );
}
