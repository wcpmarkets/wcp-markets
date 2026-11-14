import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import type { Sql } from "../deals/commands.js";
import { isStaffAdmin } from "../deals/admin.js";
import { deliver } from "../notify/push.js";
import type { ScreeningFlag } from "../listings/screening.js";
import { LISTING_IMAGES_BUCKET, createSignedDownloadUrl } from "../supabase.js";
import { UserSummarySchema, userSummaries } from "../profiles/summary.js";

/**
 * Staff review of listings held by publish-time screening (0041, design 13d-flagged).
 * "Flagged automatically — a human reviews before any listing is declined": approve
 * puts it on sale, reject removes it with a note the seller sees. Either way the
 * seller is told.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const HeldListingSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    description: z.string().nullable(),
    lane: z.string(),
    category: z.string(),
    priceKobo: z.number().int(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    imageUrls: z.array(z.string()),
    flags: z.array(z.object({ code: z.string(), detail: z.string() }).openapi("HeldListingFlag")),
    seller: UserSummarySchema,
    createdAt: z.string(),
    screenedAt: z.string().nullable(),
  })
  .openapi("HeldListing");

const ReviewSchema = z
  .object({
    decision: z.enum(["approve", "reject"]),
    /** Required on reject: the seller reads it. */
    note: z.string().trim().max(500).optional(),
  })
  .openapi("ListingReviewDecision");

const ReviewedSchema = z
  .object({ id: z.string().uuid(), status: z.enum(["active", "removed"]) })
  .openapi("ListingReviewed");

const iso = (d: string | Date | null) => (d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString());

export function registerListingReview(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/listings/held",
      summary: "Listings held by publish-time screening, oldest first (staff only)",
      tags: ["moderation"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { query: z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }) },
      responses: {
        200: { description: "Held listings", content: { "application/json": { schema: z.array(HeldListingSchema) } } },
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
      const { limit = 50 } = c.req.valid("query");
      const rows = await db<
        {
          id: string; seller_id: string; title: string; description: string | null; lane: string; category: string;
          price_kobo: string; state: string | null; city: string | null; image_paths: string[] | null;
          screening: ScreeningFlag[] | null; created_at: Date; screened_at: Date | null;
        }[]
      >`
        select id, seller_id, title, description, lane, category, price_kobo, state, city, image_paths,
               screening, created_at, screened_at
        from public.listings where status = 'held'
        order by created_at limit ${limit}`;
      const people = await userSummaries(db, rows.map((r) => r.seller_id));
      const urls = await Promise.all(
        rows.map(async (r) =>
          (await Promise.all((r.image_paths ?? []).slice(0, 4).map((p) => createSignedDownloadUrl(LISTING_IMAGES_BUCKET, p))))
            .filter((u): u is string => !!u),
        ),
      );
      return c.json(
        rows.map((r, i) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          lane: r.lane,
          category: r.category,
          priceKobo: Number(r.price_kobo),
          state: r.state,
          city: r.city,
          imageUrls: urls[i]!,
          flags: r.screening ?? [],
          seller: people.get(r.seller_id)!,
          createdAt: iso(r.created_at)!,
          screenedAt: iso(r.screened_at),
        })),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/admin/listings/{id}/review",
      summary: "Approve or reject a held listing (staff only)",
      tags: ["moderation"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ReviewSchema } } },
      },
      responses: {
        200: { description: "Reviewed", content: { "application/json": { schema: ReviewedSchema } } },
        400: { description: "A rejection needs a note", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Not staff, or staff's own listing", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "No such held listing", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const { decision, note } = c.req.valid("json");
      if (decision === "reject" && !note) return c.json({ error: "note_required" }, 400);

      const out = (await db.begin(async (tx) => {
        await tx`select set_config('wcp.moderating', 'on', true)`;
        const [l] = await tx<{ seller_id: string; title: string }[]>`
          select seller_id, title from public.listings where id = ${id} and status = 'held' for update`;
        if (!l) return { error: "not_found" as const, status: 404 as const };
        if (l.seller_id === user.sub) return { error: "conflict_of_interest" as const, status: 403 as const };
        const status = decision === "approve" ? "active" : "removed";
        await tx`
          update public.listings
          set status = ${status}, review_decision = ${decision === "approve" ? "approved" : "rejected"},
              review_note = ${note ? note : null}, reviewed_by = ${user.sub}, reviewed_at = now(), updated_at = now()
          where id = ${id}`;
        return { status, sellerId: l.seller_id, title: l.title };
      })) as { error: "not_found" | "conflict_of_interest"; status: 404 | 403 } | { status: "active" | "removed"; sellerId: string; title: string };

      if ("error" in out) return c.json({ error: out.error }, out.status);
      await notifySeller(db, id, out.sellerId, out.title, out.status === "active", note);
      return c.json({ id, status: out.status }, 200);
    },
  );
}

async function notifySeller(db: Sql, id: string, sellerId: string, title: string, approved: boolean, note?: string) {
  await deliver(db, {
    userId: sellerId,
    topic: "orders",
    title: approved ? "Your listing is live" : "Your listing wasn't approved",
    body: approved
      ? `“${title}” passed review and is now on sale.`
      : `“${title}”: ${note ?? "it didn't meet our listing rules."}`,
    key: `listing-review:${id}:${approved ? "approved" : "rejected"}`,
    // Approved opens the live listing; a rejected one isn't readable, so the app
    // opens My listings, where the note is shown.
    data: approved ? { type: "listing_review", listingId: id } : { type: "listing_review" },
  }).catch((e) => console.error("listing review notify failed", e));
}
