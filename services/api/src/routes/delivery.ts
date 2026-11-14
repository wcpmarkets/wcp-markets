import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import type { DealRow, Sql, Tx } from "../deals/commands.js";
import {
  MAX_DELIVERY_FEE_KOBO,
  UNPAID_STATES,
  formatNaira,
  listingDelivery,
  type DealDelivery,
  type ListingDelivery,
} from "../deals/delivery.js";
import { isState } from "../data/ng-regions.js";
import { isBlockedEitherWay } from "../profiles/summary.js";
import { DealSchema, dealOut } from "./deals.js";
import { toMessage, type MsgRow } from "./conversations.js";

/**
 * Delivery between the two parties (migration 0040). WCP doesn't do logistics — these
 * routes pin what the buyer and seller agreed in chat to the deal, so escrow can total:
 *
 *  - PUT  /deals/{id}/delivery-fee           seller pins the fee (7h-feereply → 7h-offer-fixed-agreed)
 *  - POST /conversations/{id}/coverage-request  buyer asks to be delivered to their state (12b-request)
 *  - POST /conversations/{id}/coverage-reply    seller adds the state (+ a fee) or can't (12b-seller)
 *  - PUT  /deals/{id}/handoff-window         seller confirms when it changes hands, after payment (20g)
 *
 * Each also drops a structured card in the chat (messages.kind), so the other side sees it
 * where the conversation is happening.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const MessageOutSchema = z
  .object({
    id: z.number().int(),
    conversationId: z.string().uuid(),
    dealId: z.string().uuid().nullable(),
    senderId: z.string().uuid(),
    body: z.string(),
    kind: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("DeliveryCard");

const DeliveryFeeSchema = z
  .object({ feeKobo: z.number().int().min(0).max(MAX_DELIVERY_FEE_KOBO) })
  .openapi("DeliveryFeeSet");
const CoverageRequestSchema = z.object({ state: z.string().min(1).max(64) }).openapi("CoverageRequest");
const CoverageReplySchema = z
  .object({
    state: z.string().min(1).max(64),
    /** true = add the state to the listing's delivery coverage; false = can't deliver there. */
    accept: z.boolean(),
    /** With accept: the fee for this buyer, pinned to their open deal if there is one. */
    feeKobo: z.number().int().min(0).max(MAX_DELIVERY_FEE_KOBO).optional(),
  })
  .openapi("CoverageReply");
const HandoffWindowSchema = z.object({ window: z.string().trim().min(1).max(60) }).openapi("HandoffWindow");

const errors = {
  401: { description: "Unauthorized" },
  403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
  404: { description: "Not found" },
  409: { description: "Not allowed in this state", content: { "application/json": { schema: ErrorSchema } } },
  422: { description: "Invalid", content: { "application/json": { schema: ErrorSchema } } },
  503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
} as const;

async function card(
  sql: Sql | Tx,
  p: { dealId: string | null; conversationId: string | null; senderId: string; body: string; kind: string; meta: object },
): Promise<MsgRow> {
  // A deal_id files it under the deal's conversation (messages_link trigger).
  const [m] = await sql<MsgRow[]>`
    insert into public.messages (deal_id, conversation_id, sender_id, body, kind, meta)
    values (${p.dealId}, ${p.conversationId}, ${p.senderId}, ${p.body}, ${p.kind}, ${sql.json(p.meta as never)})
    returning id, conversation_id, deal_id, sender_id, body, kind, meta, created_at
  `;
  return m!;
}

/** Pin a fee on an unpaid deliver deal, inside the caller's tx (the deal row is locked). */
async function pinFee(sql: Tx, deal: DealRow, sellerId: string, feeKobo: number): Promise<DealRow> {
  const delivery: DealDelivery = { ...deal.delivery!, feeKobo };
  const [d] = await sql<DealRow[]>`
    update public.deals set delivery = ${sql.json(delivery as never)} where id = ${deal.id} returning *
  `;
  const where = [deal.delivery?.place, deal.delivery?.state].filter(Boolean).join(", ");
  await card(sql, {
    dealId: deal.id,
    conversationId: null,
    senderId: sellerId,
    body: `🚚 Delivery fee: ${formatNaira(feeKobo)}${where ? ` to ${where}` : ""} — pinned to the deal`,
    kind: "delivery_fee",
    meta: { feeKobo, state: deal.delivery?.state ?? null },
  });
  return d!;
}

export function registerDelivery(app: OpenAPIHono<AuthEnv>) {
  // ── PUT /deals/{id}/delivery-fee ─────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "put",
      path: "/deals/{id}/delivery-fee",
      summary: "Seller pins the delivery fee agreed in chat (unpaid deliver deals)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DeliveryFeeSchema } } },
      },
      responses: { 200: { description: "Pinned", content: { "application/json": { schema: DealSchema } } }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { feeKobo } = c.req.valid("json");
      const r = await db.begin(async (sql) => {
        const [deal] = await sql<DealRow[]>`select * from public.deals where id = ${id} for update`;
        if (!deal || deal.seller_id !== user.sub) return { err: "not_found" as const };
        if (!(UNPAID_STATES as readonly string[]).includes(deal.state)) return { err: "already_paid" as const };
        if (deal.delivery?.method !== "deliver") return { err: "not_a_delivery" as const };
        return { deal: await pinFee(sql, deal, user.sub, feeKobo) };
      });
      if ("err" in r) return r.err === "not_found" ? c.json({ error: "not_found" }, 404) : c.json({ error: r.err! }, 409);
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );

  // ── POST /conversations/{id}/coverage-request ────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/conversations/{id}/coverage-request",
      summary: "Buyer asks the seller to deliver to a state outside their coverage",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: CoverageRequestSchema } } },
      },
      responses: { 201: { description: "Asked", content: { "application/json": { schema: MessageOutSchema } } }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { state } = c.req.valid("json");
      if (!isState(state)) return c.json({ error: "unknown_state" }, 422);
      const [conv] = await db<
        { buyer_id: string; seller_id: string; lane: string; attributes: Record<string, unknown> | null; listing_state: string | null }[]
      >`
        select c.buyer_id, c.seller_id, l.lane, l.attributes, l.state as listing_state
        from public.conversations c join public.listings l on l.id = c.listing_id where c.id = ${id}
      `;
      if (!conv || conv.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);
      if (await isBlockedEitherWay(db, conv.buyer_id, conv.seller_id)) return c.json({ error: "blocked" }, 403);
      if (conv.lane !== "goods") return c.json({ error: "not_goods" }, 409);
      const offered = listingDelivery(conv.attributes as never, conv.listing_state);
      if (!offered.modes.includes("deliver")) return c.json({ error: "seller_does_not_deliver" }, 409);
      if (offered.states.includes(state)) return c.json({ error: "already_covered" }, 409);
      // One pending ask per state: a second tap hands back the first.
      const [prior] = await db<MsgRow[]>`
        select id, conversation_id, deal_id, sender_id, body, kind, meta, created_at from public.messages
        where conversation_id = ${id} and kind = 'coverage_request' and meta->>'state' = ${state} and meta->>'status' = 'pending'
        order by id desc limit 1
      `;
      if (prior) return c.json(toMessage(prior), 201);
      const m = await card(db, {
        dealId: null,
        conversationId: id,
        senderId: user.sub,
        body: `📍 Delivery request: can you deliver to ${state}? It's outside your current coverage.`,
        kind: "coverage_request",
        meta: { state, status: "pending" },
      });
      return c.json(toMessage(m), 201);
    },
  );

  // ── POST /conversations/{id}/coverage-reply ──────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/conversations/{id}/coverage-reply",
      summary: "Seller answers a delivery request: add the state (with a fee) or can't",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: CoverageReplySchema } } },
      },
      responses: { 201: { description: "Answered", content: { "application/json": { schema: MessageOutSchema } } }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      if (!isState(b.state)) return c.json({ error: "unknown_state" }, 422);
      const r = await db.begin(async (sql) => {
        const [conv] = await sql<{ buyer_id: string; seller_id: string; listing_id: string }[]>`
          select buyer_id, seller_id, listing_id from public.conversations where id = ${id}
        `;
        if (!conv || conv.seller_id !== user.sub) return { err: "not_found" as const };
        const [listing] = await sql<{ lane: string; attributes: Record<string, unknown> | null; state: string | null }[]>`
          select lane, attributes, state from public.listings where id = ${conv.listing_id} for update
        `;
        if (!listing || listing.lane !== "goods") return { err: "not_goods" as const };

        if (b.accept) {
          const now = listingDelivery(listing.attributes as never, listing.state);
          const next: ListingDelivery = {
            modes: now.modes.includes("deliver") ? now.modes : [...now.modes, "deliver"],
            states: [...new Set([...now.states, b.state])],
          };
          await sql`
            update public.listings
            set attributes = coalesce(attributes, '{}'::jsonb) || jsonb_build_object('delivery', ${sql.json(next as never)}::jsonb)
            where id = ${conv.listing_id}
          `;
        }
        await sql`
          update public.messages set meta = meta || jsonb_build_object('status', ${b.accept ? "accepted" : "declined"}::text)
          where conversation_id = ${id} and kind = 'coverage_request' and meta->>'state' = ${b.state} and meta->>'status' = 'pending'
        `;
        const m = await card(sql, {
          dealId: null,
          conversationId: id,
          senderId: user.sub,
          body: b.accept
            ? `✓ I now deliver to ${b.state}${b.feeKobo != null ? ` — delivery fee ${formatNaira(b.feeKobo)}` : ""}.`
            : `Sorry — I can't deliver to ${b.state}. You can still meet or pick up.`,
          kind: "coverage_reply",
          meta: { state: b.state, status: b.accept ? "accepted" : "declined", feeKobo: b.accept ? (b.feeKobo ?? null) : null },
        });
        // The buyer's open deliver deal to that state: the fee pins straight onto it.
        if (b.accept && b.feeKobo != null) {
          const [deal] = await sql<DealRow[]>`
            select * from public.deals
            where listing_id = ${conv.listing_id} and buyer_id = ${conv.buyer_id}
              and state = any(${[...UNPAID_STATES]}::text[])
              and delivery->>'method' = 'deliver' and delivery->>'state' = ${b.state}
            limit 1 for update
          `;
          if (deal) await pinFee(sql, deal, user.sub, b.feeKobo);
        }
        return { m };
      });
      if ("err" in r) return r.err === "not_found" ? c.json({ error: "not_found" }, 404) : c.json({ error: r.err! }, 409);
      return c.json(toMessage(r.m!), 201);
    },
  );

  // ── PUT /deals/{id}/handoff-window ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "put",
      path: "/deals/{id}/handoff-window",
      summary: "Seller confirms when the paid item changes hands (20g)",
      tags: ["deals"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: HandoffWindowSchema } } },
      },
      responses: { 200: { description: "Confirmed", content: { "application/json": { schema: DealSchema } } }, ...errors },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { window } = c.req.valid("json");
      const r = await db.begin(async (sql) => {
        const [deal] = await sql<DealRow[]>`select * from public.deals where id = ${id} for update`;
        if (!deal || deal.seller_id !== user.sub) return { err: "not_found" as const };
        if (deal.state !== "PAID_IN_ESCROW") return { err: "not_paid" as const };
        if (!deal.delivery) return { err: "no_delivery_terms" as const };
        const [d] = await sql<DealRow[]>`
          update public.deals set delivery = ${sql.json({ ...deal.delivery, window } as never)} where id = ${id} returning *
        `;
        const how = deal.delivery.method === "deliver" ? "Delivery" : deal.delivery.method === "meet" ? "Meet-up" : "Pickup";
        await card(sql, {
          dealId: id,
          conversationId: null,
          senderId: user.sub,
          body: `📦 ${how} window confirmed: ${window}`,
          kind: "handoff_window",
          meta: { window },
        });
        return { deal: d! };
      });
      if ("err" in r) return r.err === "not_found" ? c.json({ error: "not_found" }, 404) : c.json({ error: r.err! }, 409);
      return c.json(await dealOut(db, r.deal, user.sub), 200);
    },
  );
}
