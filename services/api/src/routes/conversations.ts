import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import type { Sql } from "../deals/commands.js";
import { LISTING_IMAGES_BUCKET, createSignedDownloadUrl } from "../supabase.js";
import { UserSummarySchema, isBlockedEitherWay, userSummaries } from "../profiles/summary.js";
import { ViewingSchema, toViewing, type ViewingRow } from "./viewings.js";
import { QuoteRequestSchema, conversationRequests } from "./services.js";

/**
 * Phase 3 A — conversations: one thread per (listing, buyer), opened from a listing's
 * Chat button before any offer, and carrying every deal that buyer opens on it. The
 * inbox (7h-inbox) lists them with the latest deal's state pinned to each row.
 * Writes are service-role through here; clients may also READ conversations and
 * messages directly via Realtime, gated by RLS (migration 0022).
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ConversationListingSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    lane: z.string(),
    /** Property only: rent | sale | shortlet — a shortlet thread books dates, never offers. */
    dealType: z.string().optional(),
    priceKobo: z.number().int().nonnegative(),
    status: z.string(),
    imageUrl: z.string().nullable(),
  })
  .openapi("ConversationListing");

const ConversationMessageSchema = z
  .object({
    id: z.number().int(),
    conversationId: z.string().uuid(),
    dealId: z.string().uuid().nullable(),
    senderId: z.string().uuid(),
    body: z.string(),
    createdAt: z.string(),
  })
  .openapi("ConversationMessage");

const ConversationSchema = z
  .object({
    id: z.string().uuid(),
    role: z.enum(["buyer", "seller"]),
    listing: ConversationListingSchema,
    counterpart: UserSummarySchema,
    lastMessage: z
      .object({ body: z.string(), senderId: z.string().uuid(), createdAt: z.string() })
      .nullable()
      .openapi("ConversationLastMessage"),
    unreadCount: z.number().int().nonnegative(),
    /** The most recent deal on this listing between these two, if any. */
    deal: z.object({ id: z.string().uuid(), state: z.string() }).nullable().openapi("ConversationDeal"),
    blocked: z.boolean(),
    /** The live (proposed or confirmed) viewing in this thread; absent when there is none (0024).
     *  Optional rather than nullable: .nullable() on a registered schema makes the
     *  component itself nullable, and every other use becomes an allOf wrapper. */
    viewing: ViewingSchema.optional(),
    /** Services: the buyer's open brief in this thread (22c-quotecard "Your request"). */
    quoteRequest: QuoteRequestSchema.optional(),
    createdAt: z.string(),
  })
  .openapi("Conversation");

const ConversationPageSchema = z
  .object({
    items: z.array(ConversationSchema),
    /** Pass as `before` for the next page; null when there are no more. */
    nextCursor: z.string().nullable(),
    /** Conversations with unread messages, across all filters — for the tab badge. */
    unreadConversations: z.number().int().nonnegative(),
  })
  .openapi("ConversationPage");

const MessageSendSchema = z
  .object({ body: z.string().trim().min(1).max(2000) })
  .openapi("ConversationMessageCreate");

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

type ConvRow = {
  id: string;
  buyer_id: string;
  seller_id: string;
  created_at: string | Date;
  last_message_at: string | Date | null;
  listing_id: string;
  title: string;
  lane: string;
  deal_type: string | null;
  price_kobo: string | number;
  status: string;
  image_path: string | null;
  last_body: string | null;
  last_sender: string | null;
  last_at: string | Date | null;
  unread: number;
  deal_id: string | null;
  deal_state: string | null;
  blocked: boolean;
  viewing: ViewingRow | null;
};

/** One query for both the inbox and a single conversation. `me` scopes unread + role. */
function convQuery(db: Sql, me: string) {
  return db`
    select c.id, c.buyer_id, c.seller_id, c.created_at, c.last_message_at,
      l.id as listing_id, l.title, l.lane, l.attributes->>'dealType' as deal_type, l.price_kobo, l.status, l.image_paths[1] as image_path,
      lm.body as last_body, lm.sender_id as last_sender, lm.created_at as last_at,
      (select count(*)::int from public.messages m
        where m.conversation_id = c.id and m.sender_id <> ${me}
          and m.created_at > coalesce(
            case when c.buyer_id = ${me} then c.buyer_last_read_at else c.seller_last_read_at end,
            '-infinity'::timestamptz)) as unread,
      d.id as deal_id, d.state as deal_state,
      exists (select 1 from public.blocks b
        where (b.blocker_id = c.buyer_id and b.blocked_id = c.seller_id)
           or (b.blocker_id = c.seller_id and b.blocked_id = c.buyer_id)) as blocked,
      (select to_jsonb(v) from public.viewings v
        where v.conversation_id = c.id and v.status in ('proposed', 'confirmed')
        limit 1) as viewing
    from public.conversations c
    join public.listings l on l.id = c.listing_id
    left join lateral (
      select body, sender_id, created_at from public.messages
      where conversation_id = c.id order by created_at desc, id desc limit 1
    ) lm on true
    left join lateral (
      select id, state from public.deals
      where listing_id = c.listing_id and buyer_id = c.buyer_id
      order by created_at desc limit 1
    ) d on true
  `;
}

async function toConversations(db: Sql, me: string, rows: ConvRow[]) {
  const people = await userSummaries(
    db,
    rows.map((r) => (r.buyer_id === me ? r.seller_id : r.buyer_id)),
  );
  const requests = await conversationRequests(
    db,
    rows.filter((r) => r.lane === "services").map((r) => r.id),
  );
  return Promise.all(
    rows.map(async (r) => {
      const other = r.buyer_id === me ? r.seller_id : r.buyer_id;
      return {
        id: r.id,
        role: r.buyer_id === me ? ("buyer" as const) : ("seller" as const),
        listing: {
          id: r.listing_id,
          title: r.title,
          lane: r.lane,
          dealType: r.deal_type ?? undefined,
          priceKobo: Number(r.price_kobo),
          status: r.status,
          imageUrl: r.image_path ? await createSignedDownloadUrl(LISTING_IMAGES_BUCKET, r.image_path) : null,
        },
        counterpart: people.get(other)!,
        lastMessage:
          r.last_body != null && r.last_sender && r.last_at
            ? { body: r.last_body, senderId: r.last_sender, createdAt: iso(r.last_at) }
            : null,
        unreadCount: r.unread,
        deal: r.deal_id && r.deal_state ? { id: r.deal_id, state: r.deal_state } : null,
        blocked: r.blocked,
        viewing: r.viewing ? toViewing(r.viewing) : undefined,
        quoteRequest: requests.get(r.id),
        createdAt: iso(r.created_at),
      };
    }),
  );
}

async function loadConversation(db: Sql, me: string, id: string): Promise<ConvRow | null> {
  const [row] = await db<ConvRow[]>`
    select * from (${convQuery(db, me)}) x
    where x.id = ${id} and ${me} in (x.buyer_id, x.seller_id)
  `;
  return row ?? null;
}

// messages.id is bigint, which postgres.js returns as a string — Number() it at the
// boundary so the wire matches the contract's integer.
type MsgRow = { id: number | string; conversation_id: string; deal_id: string | null; sender_id: string; body: string; created_at: string | Date };
const toMessage = (m: MsgRow) => ({
  id: Number(m.id),
  conversationId: m.conversation_id,
  dealId: m.deal_id,
  senderId: m.sender_id,
  body: m.body,
  createdAt: iso(m.created_at),
});

export function registerConversations(app: OpenAPIHono<AuthEnv>) {
  // ── POST /listings/{id}/conversations — open (or reuse) the thread ──────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/conversations",
      summary: "Open a conversation with the seller (returns the existing one if any)",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Existing conversation", content: { "application/json": { schema: ConversationSchema } } },
        201: { description: "New conversation", content: { "application/json": { schema: ConversationSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Own listing, or blocked", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Listing not found or not active", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");

      const [existing] = await db<{ id: string }[]>`
        select id from public.conversations where listing_id = ${id} and buyer_id = ${user.sub}
      `;
      if (existing) {
        const row = await loadConversation(db, user.sub, existing.id);
        return c.json((await toConversations(db, user.sub, [row!]))[0]!, 200);
      }

      const [listing] = await db<{ seller_id: string; status: string }[]>`
        select seller_id, status from public.listings where id = ${id}
      `;
      if (!listing || listing.status !== "active") return c.json({ error: "listing_unavailable" }, 404);
      if (listing.seller_id === user.sub) return c.json({ error: "own_listing" }, 403);
      if (await isBlockedEitherWay(db, user.sub, listing.seller_id)) return c.json({ error: "blocked" }, 403);

      const [created] = await db<{ id: string }[]>`
        insert into public.conversations (listing_id, buyer_id, seller_id)
        values (${id}, ${user.sub}, ${listing.seller_id})
        on conflict (listing_id, buyer_id) do update set updated_at = now()
        returning id
      `;
      const row = await loadConversation(db, user.sub, created!.id);
      return c.json((await toConversations(db, user.sub, [row!]))[0]!, 201);
    },
  );

  // ── GET /conversations — the inbox ──────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/conversations",
      summary: "The user's conversations, most recent first (empty threads omitted)",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        query: z.object({
          filter: z.enum(["all", "buying", "selling", "unread"]).optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
          before: z.string().datetime({ offset: true }).optional(),
        }),
      },
      responses: {
        200: { description: "Inbox page", content: { "application/json": { schema: ConversationPageSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const q = c.req.valid("query");
      const filter = q.filter ?? "all";
      const limit = q.limit ?? 30;
      const me = user.sub;

      const rows = await db<ConvRow[]>`
        select * from (${convQuery(db, me)}) x
        where ${me} in (x.buyer_id, x.seller_id)
          and x.last_message_at is not null
          ${filter === "buying" ? db`and x.buyer_id = ${me}` : db``}
          ${filter === "selling" ? db`and x.seller_id = ${me}` : db``}
          ${filter === "unread" ? db`and x.unread > 0` : db``}
          ${q.before ? db`and x.last_message_at < ${q.before}::timestamptz` : db``}
        order by x.last_message_at desc, x.id
        limit ${limit + 1}
      `;
      const page = rows.slice(0, limit);
      const [{ n } = { n: 0 }] = await db<{ n: number }[]>`
        select count(*)::int as n from public.conversations c
        where ${me} in (c.buyer_id, c.seller_id) and exists (
          select 1 from public.messages m
          where m.conversation_id = c.id and m.sender_id <> ${me}
            and m.created_at > coalesce(
              case when c.buyer_id = ${me} then c.buyer_last_read_at else c.seller_last_read_at end,
              '-infinity'::timestamptz))
      `;
      const last = page[page.length - 1];
      return c.json(
        {
          items: await toConversations(db, me, page),
          nextCursor: rows.length > limit && last?.last_message_at ? iso(last.last_message_at) : null,
          unreadConversations: n,
        },
        200,
      );
    },
  );

  // ── GET /conversations/{id} ─────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/conversations/{id}",
      summary: "One conversation (party only)",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Conversation", content: { "application/json": { schema: ConversationSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const row = await loadConversation(db, user.sub, c.req.valid("param").id);
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json((await toConversations(db, user.sub, [row]))[0]!, 200);
    },
  );

  // ── GET /conversations/{id}/messages ────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/conversations/{id}/messages",
      summary: "Messages in a conversation, oldest first (party only)",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        query: z.object({
          /** Only messages with an id greater than this (catch-up after a reconnect). */
          after: z.coerce.number().int().min(0).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
      },
      responses: {
        200: { description: "Messages", content: { "application/json": { schema: z.array(ConversationMessageSchema) } } },
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
      const q = c.req.valid("query");
      const [conv] = await db<{ ok: boolean }[]>`
        select true as ok from public.conversations where id = ${id} and ${user.sub} in (buyer_id, seller_id)
      `;
      if (!conv) return c.json({ error: "not_found" }, 404);
      // The latest `limit` messages (after the cursor), returned oldest first.
      const rows = await db<MsgRow[]>`
        select * from (
          select id, conversation_id, deal_id, sender_id, body, created_at
          from public.messages
          where conversation_id = ${id} ${q.after != null ? db`and id > ${q.after}` : db``}
          order by id desc limit ${q.limit ?? 100}
        ) x order by id
      `;
      return c.json(rows.map(toMessage), 200);
    },
  );

  // ── POST /conversations/{id}/messages ───────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/conversations/{id}/messages",
      summary: "Send a message (party only; blocked either way → 403)",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "msg", limit: 60, windowSecs: 60, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: MessageSendSchema } } },
      },
      responses: {
        201: { description: "Sent", content: { "application/json": { schema: ConversationMessageSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { body } = c.req.valid("json");
      const [conv] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.conversations where id = ${id} and ${user.sub} in (buyer_id, seller_id)
      `;
      if (!conv) return c.json({ error: "not_found" }, 404);
      if (await isBlockedEitherWay(db, conv.buyer_id, conv.seller_id)) return c.json({ error: "blocked" }, 403);
      const [m] = await db<MsgRow[]>`
        insert into public.messages (conversation_id, sender_id, body)
        values (${id}, ${user.sub}, ${body})
        returning id, conversation_id, deal_id, sender_id, body, created_at
      `;
      // Sending implies you've read everything up to your own message.
      await markRead(db, id, user.sub, conv);
      return c.json(toMessage(m!), 201);
    },
  );

  // ── POST /conversations/{id}/read ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/conversations/{id}/read",
      summary: "Mark the conversation read up to now",
      tags: ["conversations"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "Marked read" },
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
      const [conv] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.conversations where id = ${id} and ${user.sub} in (buyer_id, seller_id)
      `;
      if (!conv) return c.json({ error: "not_found" }, 404);
      await markRead(db, id, user.sub, conv);
      return c.body(null, 204);
    },
  );
}

async function markRead(db: Sql, id: string, me: string, conv: { buyer_id: string; seller_id: string }) {
  if (conv.buyer_id === me) await db`update public.conversations set buyer_last_read_at = now() where id = ${id}`;
  else await db`update public.conversations set seller_last_read_at = now() where id = ${id}`;
}
