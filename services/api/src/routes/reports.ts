import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import type { Sql } from "../deals/commands.js";
import { isStaffAdmin } from "../deals/admin.js";
import { UserSummarySchema, userSummaries } from "../profiles/summary.js";

/**
 * Phase 3 B — reporting and moderation (migration 0023).
 *
 * Anyone signed in can report a listing, a person, or a message in a thread they're
 * part of. Reports are anonymous to the reported party and service-role only.
 *
 * Auto-pause (design 7g-report: "scam reports pause the listing immediately pending
 * human review") is bounded so one account can't take down a competitor:
 *   - a SCAM report pauses an active listing at once only when the reporter has a
 *     conversation on that listing — i.e. they were actually dealing with the seller;
 *   - otherwise a listing pauses once PAUSE_THRESHOLD distinct people have open
 *     reports on it.
 * Paused listings move to status 'under_review', which every public read already
 * excludes. Staff (staff_roles.role = 'admin') then dismiss (restoring it), remove
 * it, or uphold a report about a person or message.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

export const PAUSE_THRESHOLD = 3;

const REASONS = ["scam", "counterfeit", "prohibited", "misleading", "offensive", "harassment", "other"] as const;
const TARGETS = ["listing", "user", "message"] as const;

const ReportCreateSchema = z
  .object({
    targetType: z.enum(TARGETS),
    listingId: z.string().uuid().optional(),
    userId: z.string().uuid().optional(),
    messageId: z.number().int().positive().optional(),
    reason: z.enum(REASONS),
    details: z.string().trim().max(1000).optional(),
    /** Also block the reported person (the sheet's "Also block" toggle). */
    block: z.boolean().optional(),
  })
  .openapi("ReportCreate");

const ReportReceiptSchema = z
  .object({
    id: z.string().uuid(),
    /** True when an open report from this person already existed — nothing new filed. */
    duplicate: z.boolean(),
    /** True when this report took the listing out of circulation pending review. */
    listingPaused: z.boolean(),
    blocked: z.boolean(),
  })
  .openapi("ReportReceipt");

const ReportQueueItemSchema = z
  .object({
    id: z.string().uuid(),
    targetType: z.enum(TARGETS),
    reason: z.enum(REASONS),
    details: z.string().nullable(),
    reporterId: z.string().uuid(),
    reportedUser: UserSummarySchema,
    listing: z
      .object({ id: z.string().uuid(), title: z.string(), status: z.string() })
      .nullable()
      .openapi("ReportedListing"),
    message: z
      .object({ id: z.number().int(), body: z.string(), conversationId: z.string().uuid() })
      .nullable()
      .openapi("ReportedMessage"),
    pausedListing: z.boolean(),
    /** Open reports on the same target from all reporters (this one included). */
    openReportsOnTarget: z.number().int(),
    /** Reports against this person in the last 30 days, any status. */
    reportsAgainstUser30d: z.number().int(),
    createdAt: z.string(),
  })
  .openapi("ReportQueueItem");

const ResolveSchema = z
  .object({
    /**
     * dismiss        — no violation: closes every open report on the target and, if
     *                  the listing was paused, puts it back on sale.
     * remove_listing — takes the listing down for good (listing/message reports).
     * uphold         — a violation by a person or in a message, handled outside the
     *                  listing (e.g. a warning); closes the reports as actioned.
     */
    action: z.enum(["dismiss", "remove_listing", "uphold"]),
    note: z.string().trim().max(500).optional(),
  })
  .openapi("ReportResolve");

const ResolvedSchema = z
  .object({
    resolved: z.number().int(),
    listingStatus: z.string().nullable(),
  })
  .openapi("ReportResolution");

const iso = (d: string | Date) => (d instanceof Date ? d : new Date(d)).toISOString();

/** Run `fn` in a transaction allowed to move listings into/out of moderation states. */
async function moderating<T>(db: Sql, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return (await db.begin(async (tx) => {
    await tx`select set_config('wcp.moderating', 'on', true)`;
    return fn(tx as unknown as Sql);
  })) as T;
}

export function registerReports(app: OpenAPIHono<AuthEnv>) {
  // ── POST /reports — file a report ───────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/reports",
      summary: "Report a listing, a person, or a message",
      tags: ["moderation"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "report", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: { body: { content: { "application/json": { schema: ReportCreateSchema } } } },
      responses: {
        201: { description: "Report filed", content: { "application/json": { schema: ReportReceiptSchema } } },
        200: { description: "Already reported (open)", content: { "application/json": { schema: ReportReceiptSchema } } },
        400: { description: "Invalid target", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Not a party to that message", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Target not found", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");

      // Resolve the target to (listing, message, reported person).
      let listingId: string | null = null;
      let messageId: number | null = null;
      let reportedUserId: string;
      if (b.targetType === "listing") {
        if (!b.listingId) return c.json({ error: "listing_id_required" }, 400);
        const [l] = await db<{ seller_id: string; status: string }[]>`
          select seller_id, status from public.listings where id = ${b.listingId}
        `;
        // Drafts aren't public, so they can't have been seen to be reported.
        if (!l || l.status === "draft") return c.json({ error: "not_found" }, 404);
        listingId = b.listingId;
        reportedUserId = l.seller_id;
      } else if (b.targetType === "message") {
        if (!b.messageId) return c.json({ error: "message_id_required" }, 400);
        const [m] = await db<{ sender_id: string; buyer_id: string; seller_id: string }[]>`
          select m.sender_id, cv.buyer_id, cv.seller_id
          from public.messages m join public.conversations cv on cv.id = m.conversation_id
          where m.id = ${b.messageId}
        `;
        if (!m) return c.json({ error: "not_found" }, 404);
        if (user.sub !== m.buyer_id && user.sub !== m.seller_id) return c.json({ error: "forbidden" }, 403);
        messageId = b.messageId;
        reportedUserId = m.sender_id;
      } else {
        if (!b.userId) return c.json({ error: "user_id_required" }, 400);
        const [u] = await db<{ ok: boolean }[]>`select exists (select 1 from auth.users where id = ${b.userId}) as ok`;
        if (!u?.ok) return c.json({ error: "not_found" }, 404);
        reportedUserId = b.userId;
      }
      if (reportedUserId === user.sub) return c.json({ error: "cannot_report_self" }, 400);

      const details = b.details ? b.details : null;
      const result = await moderating(db, async (tx) => {
        const inserted = await tx<{ id: string }[]>`
          insert into public.reports (reporter_id, target_type, listing_id, message_id, reported_user_id, reason, details)
          values (${user.sub}, ${b.targetType}, ${listingId}, ${messageId}, ${reportedUserId}, ${b.reason}, ${details})
          on conflict do nothing
          returning id
        `;
        if (!inserted[0]) {
          const [existing] = await tx<{ id: string }[]>`
            select id from public.reports
            where reporter_id = ${user.sub} and target_type = ${b.targetType} and status = 'open'
              and coalesce(listing_id::text, message_id::text, reported_user_id::text)
                  = coalesce(${listingId}::text, ${messageId}::text, ${reportedUserId}::text)
          `;
          return { id: existing!.id, duplicate: true, paused: false };
        }
        const id = inserted[0].id;

        // Auto-pause: only listing reports, only listings currently on sale.
        let paused = false;
        if (listingId) {
          const [ctx] = await tx<{ status: string; engaged: boolean; reporters: number }[]>`
            select l.status,
                   exists (select 1 from public.conversations cv
                           where cv.listing_id = l.id and cv.buyer_id = ${user.sub}) as engaged,
                   (select count(distinct r.reporter_id) from public.reports r
                    where r.listing_id = l.id and r.status = 'open')::int as reporters
            from public.listings l where l.id = ${listingId} for update
          `;
          if (
            ctx?.status === "active" &&
            ((b.reason === "scam" && ctx.engaged) || ctx.reporters >= PAUSE_THRESHOLD)
          ) {
            await tx`update public.listings set status = 'under_review' where id = ${listingId}`;
            await tx`update public.reports set paused_listing = true where id = ${id}`;
            paused = true;
          }
        }
        return { id, duplicate: false, paused };
      });

      let blocked = false;
      if (b.block) {
        await db`
          insert into public.blocks (blocker_id, blocked_id) values (${user.sub}, ${reportedUserId})
          on conflict do nothing
        `;
        blocked = true;
      }

      return c.json(
        { id: result.id, duplicate: result.duplicate, listingPaused: result.paused, blocked },
        result.duplicate ? 200 : 201,
      );
    },
  );

  // ── GET /admin/reports — the moderation queue (staff only) ──────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/reports",
      summary: "Open report queue, oldest first (staff only)",
      tags: ["moderation"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(100).optional(),
          targetType: z.enum(TARGETS).optional(),
        }),
      },
      responses: {
        200: { description: "Open reports", content: { "application/json": { schema: z.array(ReportQueueItemSchema) } } },
        401: { description: "Unauthorized" },
        403: { description: "Not staff", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const { limit = 50, targetType } = c.req.valid("query");
      const rows = await db<
        {
          id: string;
          target_type: (typeof TARGETS)[number];
          reason: (typeof REASONS)[number];
          details: string | null;
          reporter_id: string;
          reported_user_id: string;
          listing_id: string | null;
          listing_title: string | null;
          listing_status: string | null;
          message_id: string | number | null;
          message_body: string | null;
          conversation_id: string | null;
          paused_listing: boolean;
          open_on_target: number;
          against_user_30d: number;
          created_at: string | Date;
        }[]
      >`
        select r.id, r.target_type, r.reason, r.details, r.reporter_id, r.reported_user_id,
               r.listing_id, l.title as listing_title, l.status as listing_status,
               r.message_id, m.body as message_body, m.conversation_id,
               r.paused_listing, r.created_at,
               (select count(*) from public.reports o
                where o.status = 'open' and o.target_type = r.target_type
                  and coalesce(o.listing_id::text, o.message_id::text, o.reported_user_id::text)
                    = coalesce(r.listing_id::text, r.message_id::text, r.reported_user_id::text))::int as open_on_target,
               (select count(*) from public.reports o
                where o.reported_user_id = r.reported_user_id
                  and o.created_at > now() - interval '30 days')::int as against_user_30d
        from public.reports r
        left join public.listings l on l.id = r.listing_id
        left join public.messages m on m.id = r.message_id
        where r.status = 'open' ${targetType ? db`and r.target_type = ${targetType}` : db``}
        order by r.created_at
        limit ${limit}
      `;
      const people = await userSummaries(db, rows.map((r) => r.reported_user_id));
      return c.json(
        rows.map((r) => ({
          id: r.id,
          targetType: r.target_type,
          reason: r.reason,
          details: r.details,
          reporterId: r.reporter_id,
          reportedUser: people.get(r.reported_user_id)!,
          listing: r.listing_id ? { id: r.listing_id, title: r.listing_title ?? "", status: r.listing_status ?? "" } : null,
          message:
            r.message_id != null
              ? { id: Number(r.message_id), body: r.message_body ?? "", conversationId: r.conversation_id ?? "" }
              : null,
          pausedListing: r.paused_listing,
          openReportsOnTarget: r.open_on_target,
          reportsAgainstUser30d: r.against_user_30d,
          createdAt: iso(r.created_at),
        })),
        200,
      );
    },
  );

  // ── POST /admin/reports/{id}/resolve — staff decision ───────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/reports/{id}/resolve",
      summary: "Resolve a report and every other open report on the same target (staff only)",
      tags: ["moderation"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ResolveSchema } } },
      },
      responses: {
        200: { description: "Resolved", content: { "application/json": { schema: ResolvedSchema } } },
        400: { description: "Action doesn't fit the target", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Not staff, or staff involved in the report", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "No such open report", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const { action, note } = c.req.valid("json");

      const out = await moderating(db, async (tx) => {
        const [r] = await tx<
          { target_type: string; listing_id: string | null; message_id: string | number | null; reported_user_id: string; reporter_id: string }[]
        >`
          select target_type, listing_id, message_id, reported_user_id, reporter_id
          from public.reports where id = ${id} and status = 'open' for update
        `;
        if (!r) return { error: "not_found" as const, status: 404 as const };
        // Conflict of interest: staff never rule on reports they filed or that name them.
        if (r.reporter_id === user.sub || r.reported_user_id === user.sub) {
          return { error: "conflict_of_interest" as const, status: 403 as const };
        }
        if (action === "remove_listing" && !r.listing_id) {
          // A message report removes the listing its thread is about.
          if (r.target_type !== "message") return { error: "no_listing" as const, status: 400 as const };
        }

        let listingId = r.listing_id;
        if (action === "remove_listing" && !listingId && r.message_id != null) {
          const [m] = await tx<{ listing_id: string }[]>`
            select cv.listing_id from public.messages m
            join public.conversations cv on cv.id = m.conversation_id where m.id = ${r.message_id}
          `;
          listingId = m?.listing_id ?? null;
          if (!listingId) return { error: "no_listing" as const, status: 400 as const };
        }

        let listingStatus: string | null = null;
        if (action === "remove_listing" && listingId) {
          const [l] = await tx<{ status: string }[]>`
            update public.listings set status = 'removed' where id = ${listingId} returning status
          `;
          listingStatus = l?.status ?? null;
          // The listing is gone, so reports about the listing itself are settled too.
          await tx`
            update public.reports
            set status = 'actioned', resolved_by = ${user.sub}, resolution_note = ${note ? note : null}, resolved_at = now()
            where status = 'open' and target_type = 'listing' and listing_id = ${listingId}
          `;
        } else if (action === "dismiss" && r.listing_id) {
          // Back on sale only if reports were what took it off.
          const [l] = await tx<{ status: string }[]>`
            update public.listings set status = 'active'
            where id = ${r.listing_id} and status = 'under_review' returning status
          `;
          listingStatus = l?.status ?? (await tx<{ status: string }[]>`
            select status from public.listings where id = ${r.listing_id}
          `)[0]?.status ?? null;
        }

        const resolved = await tx`
          update public.reports
          set status = ${action === "dismiss" ? "dismissed" : "actioned"},
              resolved_by = ${user.sub},
              resolution_note = ${note ? note : null},
              resolved_at = now()
          where status = 'open' and target_type = ${r.target_type}
            and coalesce(listing_id::text, message_id::text, reported_user_id::text)
              = coalesce(${r.listing_id}::text, ${r.message_id == null ? null : String(r.message_id)}::text, ${r.reported_user_id}::text)
        `;
        return { resolved: resolved.count, listingStatus };
      });

      if ("error" in out) return c.json({ error: out.error }, out.status);
      return c.json(out, 200);
    },
  );
}
