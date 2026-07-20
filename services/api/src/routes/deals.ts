import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { createOffer, transition, type DealRow } from "../deals/commands.js";

/**
 * M3 — offers/deals + chat. Buyers open offers on listings; both parties drive the
 * negotiation through the state machine (services/api/src/deals/commands.ts). All
 * writes are service-role through here; clients only READ deals/messages (directly
 * via Realtime, gated by RLS). Money actions (pay/hand_off/…) arrive in M4+.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const DealSchema = z
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
    priceKobo: z.number().int().nonnegative(),
    qty: z.number().int().positive().optional(),
  })
  .openapi("OfferCreate");

const DealActionSchema = z
  .object({
    action: z.enum(["counter", "accept", "decline", "withdraw", "cancel"]),
    priceKobo: z.number().int().nonnegative().optional(),
    qty: z.number().int().positive().optional(),
  })
  .openapi("DealAction");

const MessageCreateSchema = z
  .object({ body: z.string().min(1).max(2000) })
  .openapi("MessageCreate");

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

function toDeal(d: DealRow, uid: string): z.infer<typeof DealSchema> {
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
        409: { description: "Listing unavailable", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const r = await createOffer(db, {
        listingId: id,
        buyerId: user.sub,
        priceKobo: b.priceKobo,
        qty: b.qty ?? 1,
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "own_listing") return c.json({ error: "cannot_offer_own_listing" }, 400);
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
      return c.json(rows.map((d) => toDeal(d, user.sub)), 200);
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
          ...toDeal(deal, user.sub),
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
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");

      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || (deal.buyer_id !== user.sub && deal.seller_id !== user.sub))
        return c.json({ error: "not_found" }, 404);
      if (b.action === "counter" && b.priceKobo == null)
        return c.json({ error: "counter_requires_price" }, 400);

      const actor = deal.buyer_id === user.sub ? "BUYER" : "SELLER";
      const r = await transition(db, {
        dealId: id,
        actor,
        actorId: user.sub,
        action: b.action,
        priceKobo: b.priceKobo,
        qty: b.qty,
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
      return c.json(toDeal(r.deal, user.sub), 200);
    },
  );

  // ── POST /deals/{id}/pay — buyer pays an accepted offer (M4) ────────────────
  // Moves ACCEPTED → PAYMENT_PENDING and enqueues an escrow hold (the EFFECTS seam).
  // The provider confirms asynchronously via webhook → PAID_IN_ESCROW. Mock for now.
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/pay",
      summary: "Pay an accepted offer (opens the escrow hold)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Payment initiated", content: { "application/json": { schema: DealSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not payable in this state", content: { "application/json": { schema: ErrorSchema } } },
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
      // Only the buyer pays.
      if (deal.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);

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
      return c.json(toDeal(r.deal, user.sub), 200);
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
        { id: number; deal_id: string; sender_id: string; body: string; created_at: string | Date }[]
      >`
        select id, deal_id, sender_id, body, created_at
        from public.messages where deal_id = ${id} order by created_at
      `;
      return c.json(
        rows.map((m) => ({
          id: m.id,
          dealId: m.deal_id,
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
      const [m] = await db<
        { id: number; deal_id: string; sender_id: string; body: string; created_at: string | Date }[]
      >`
        insert into public.messages (deal_id, sender_id, body)
        values (${id}, ${user.sub}, ${body})
        returning id, deal_id, sender_id, body, created_at
      `;
      return c.json(
        { id: m!.id, dealId: m!.deal_id, senderId: m!.sender_id, body: m!.body, createdAt: iso(m!.created_at) },
        201,
      );
    },
  );
}
