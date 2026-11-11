import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import { getDb } from "../db.js";
import { auth, type AuthEnv } from "../middleware/auth.js";

/**
 * The in-app notifications list (design 20l / 20l-empty): every notification decided for
 * the user (notify/push.ts), newest first — including those not pushed because push is
 * switched off, but not a topic the user switched off or a blocked sender. Read state is
 * per row; reading a chat marks its message notifications read too (conversations.ts).
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const TOPICS = ["orders", "messages", "watch", "promotions"] as const;

const NotificationSchema = z
  .object({
    id: z.number().int(),
    topic: z.enum(TOPICS),
    title: z.string(),
    body: z.string(),
    /** What a tap opens: a conversation (preferred) or a deal. */
    conversationId: z.string().uuid().nullable(),
    dealId: z.string().uuid().nullable(),
    read: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Notification");

const NotificationPageSchema = z
  .object({
    items: z.array(NotificationSchema),
    /** Pass as `before` for the next page; null at the end. */
    nextBefore: z.number().int().nullable(),
    unread: z.number().int(),
  })
  .openapi("NotificationPage");

const UnreadSchema = z.object({ unread: z.number().int() }).openapi("NotificationUnread");

const MarkReadSchema = z
  .object({ ids: z.array(z.number().int()).max(200).optional() })
  .openapi("NotificationsMarkRead");

type Row = {
  id: string | number;
  topic: (typeof TOPICS)[number];
  title: string;
  body: string;
  data: Record<string, string> | null;
  read_at: Date | null;
  created_at: Date;
};

export function registerNotifications(app: OpenAPIHono<AuthEnv>) {
  // Rows the list shows (shared by the list and the unread count).
  const visible = (db: NonNullable<Awaited<ReturnType<typeof getDb>>>, uid: string) =>
    db`user_id = ${uid} and status <> 'pending' and not (status = 'skipped' and coalesce(detail, '') in ('topic_off', 'blocked', 'prefs'))`;
  const unreadCount = async (db: NonNullable<Awaited<ReturnType<typeof getDb>>>, uid: string) =>
    Number((await db<{ n: number }[]>`select count(*)::int as n from public.notifications where ${visible(db, uid)} and read_at is null`)[0]!.n);

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/notifications",
      summary: "My notifications, newest first",
      tags: ["notifications"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        query: z.object({
          topic: z.enum(TOPICS).optional(),
          before: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        }),
      },
      responses: {
        200: { description: "A page", content: { "application/json": { schema: NotificationPageSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { topic, before, limit = 30 } = c.req.valid("query");
      const rows = await db<Row[]>`
        select id, topic, title, body, data, read_at, created_at from public.notifications
        where ${visible(db, uid)}
          ${topic ? db`and topic = ${topic}` : db``}
          ${before ? db`and id < ${before}` : db``}
        order by id desc
        limit ${limit + 1}`;
      const page = rows.slice(0, limit);
      return c.json(
        {
          items: page.map((r) => ({
            id: Number(r.id),
            topic: r.topic,
            title: r.title,
            body: r.body,
            conversationId: r.data?.conversationId ?? null,
            dealId: r.data?.dealId ?? null,
            read: r.read_at != null,
            createdAt: new Date(r.created_at).toISOString(),
          })),
          nextBefore: rows.length > limit ? Number(page[page.length - 1]!.id) : null,
          unread: await unreadCount(db, uid),
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/notifications/unread",
      summary: "How many notifications are unread (the bell's dot)",
      tags: ["notifications"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Count", content: { "application/json": { schema: UnreadSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      return c.json({ unread: await unreadCount(db, c.get("user").sub) }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/notifications/read",
      summary: "Mark notifications read (the given ids, or all)",
      tags: ["notifications"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { required: true, content: { "application/json": { schema: MarkReadSchema } } } },
      responses: {
        200: { description: "Marked; the new unread count", content: { "application/json": { schema: UnreadSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { ids } = c.req.valid("json");
      if (ids && ids.length === 0) return c.json({ unread: await unreadCount(db, uid) }, 200);
      await db`
        update public.notifications set read_at = now()
        where user_id = ${uid} and read_at is null ${ids ? db`and id in ${db(ids)}` : db``}`;
      return c.json({ unread: await unreadCount(db, uid) }, 200);
    },
  );
}
