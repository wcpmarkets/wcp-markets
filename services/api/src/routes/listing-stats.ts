import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { UserSummarySchema, userSummaries } from "../profiles/summary.js";

/**
 * A seller's view of one of their own ads (design 13c-detail): the last 7 days of
 * views / chats / saves against the 7 before, and the most recent buyers who showed
 * interest. Views come from listing_views_daily (a bare count, migration 0039); chats
 * are buyer threads opened on the listing; saves are ♡s (0036).
 *
 * Not built from the design: the "₦15k above market" price hint and Boost — there is no
 * price model or paid promotion behind them.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const WindowSchema = z.object({ last7: z.number().int(), prev7: z.number().int() }).openapi("StatWindow");
const InterestSchema = z
  .object({
    buyer: UserSummarySchema,
    /** "message" = they wrote in a chat; "offer" = they opened a deal; "save" = ♡. */
    kind: z.enum(["message", "offer", "save"]),
    at: z.string(),
    /** The buyer's latest message, for "message" only. */
    snippet: z.string().nullable(),
    conversationId: z.string().uuid().nullable(),
    dealId: z.string().uuid().nullable(),
  })
  .openapi("ListingInterest");
const ListingStatsSchema = z
  .object({
    views: WindowSchema,
    chats: WindowSchema,
    saves: WindowSchema,
    /** All-time ♡ count (people currently saving it). */
    savesTotal: z.number().int(),
    /** Daily views, oldest first, the last 7 days (Lagos dates) — for the trend line. */
    viewsDaily: z.array(z.number().int()),
    recent: z.array(InterestSchema),
  })
  .openapi("ListingStats");

export function registerListingStats(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/listings/{id}/stats",
      summary: "Performance of one of your own listings",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Stats", content: { "application/json": { schema: ListingStatsSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found or not yours", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");

      const [own] = await db<{ id: string }[]>`
        select id from public.listings where id = ${id} and seller_id = ${user.sub}
      `;
      if (!own) return c.json({ error: "not_found" }, 404);

      const daily = await db<{ d: number; views: number }[]>`
        with today as (select (now() at time zone 'Africa/Lagos')::date as t)
        select (today.t - v.day)::int as d, v.views
        from public.listing_views_daily v, today
        where v.listing_id = ${id} and v.day > today.t - 14
      `;
      const viewsDaily = Array.from({ length: 7 }, (_, i) => daily.find((r) => r.d === 6 - i)?.views ?? 0);
      const sum = (lo: number, hi: number) => daily.filter((r) => r.d >= lo && r.d <= hi).reduce((a, r) => a + r.views, 0);

      const [counts] = await db<
        { chats7: number; chatsPrev: number; saves7: number; savesPrev: number; savesTotal: number }[]
      >`
        select
          (select count(*)::int from public.conversations where listing_id = ${id} and created_at > now() - interval '7 days') as "chats7",
          (select count(*)::int from public.conversations where listing_id = ${id}
             and created_at <= now() - interval '7 days' and created_at > now() - interval '14 days') as "chatsPrev",
          (select count(*)::int from public.saved_listings where listing_id = ${id} and created_at > now() - interval '7 days') as "saves7",
          (select count(*)::int from public.saved_listings where listing_id = ${id}
             and created_at <= now() - interval '7 days' and created_at > now() - interval '14 days') as "savesPrev",
          (select count(*)::int from public.saved_listings where listing_id = ${id}) as "savesTotal"
      `;

      // Recent interest: each buyer once, by their latest signal — a message they sent,
      // a deal they opened, or a save.
      const signals = await db<
        { buyer_id: string; kind: "message" | "offer" | "save"; at: Date; snippet: string | null; conversation_id: string | null; deal_id: string | null }[]
      >`
        select distinct on (buyer_id) buyer_id, kind, at, snippet, conversation_id, deal_id from (
          select c.buyer_id, 'message' as kind, m.created_at as at, m.body as snippet, c.id as conversation_id, m.deal_id
          from public.conversations c
          join lateral (
            select created_at, body, deal_id from public.messages
            where conversation_id = c.id and sender_id = c.buyer_id
            order by created_at desc limit 1
          ) m on true
          where c.listing_id = ${id}
          union all
          select d.buyer_id, 'offer', d.created_at, null, null, d.id
          from public.deals d where d.listing_id = ${id}
          union all
          select s.user_id, 'save', s.created_at, null, null, null
          from public.saved_listings s where s.listing_id = ${id}
        ) x
        where buyer_id <> ${user.sub}
        order by buyer_id, at desc
      `;
      const latest = signals.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 5);
      const people = await userSummaries(db, latest.map((s) => s.buyer_id));

      return c.json(
        {
          views: { last7: sum(0, 6), prev7: sum(7, 13) },
          chats: { last7: counts!.chats7, prev7: counts!.chatsPrev },
          saves: { last7: counts!.saves7, prev7: counts!.savesPrev },
          savesTotal: counts!.savesTotal,
          viewsDaily,
          recent: latest.map((s) => ({
            buyer: people.get(s.buyer_id)!,
            kind: s.kind,
            at: s.at.toISOString(),
            snippet: s.kind === "message" ? s.snippet : null,
            conversationId: s.conversation_id,
            dealId: s.deal_id,
          })),
        },
        200,
      );
    },
  );
}
