import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";

/**
 * M7 — escrow-gated reviews. A buyer reviews a COMPLETED deal (the gate is enforced
 * in the DB by reviews_gate; the route adds friendly errors on top). The seller may
 * reply once. Reviews are public trust signals — anyone can read a seller's reviews.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ReviewSchema = z
  .object({
    id: z.string().uuid(),
    dealId: z.string().uuid(),
    reviewerId: z.string().uuid(),
    sellerId: z.string().uuid(),
    rating: z.number().int().min(1).max(5),
    body: z.string().nullable(),
    sellerReply: z.string().nullable(),
    createdAt: z.string(),
    repliedAt: z.string().nullable(),
  })
  .openapi("Review");

const ReviewCreateSchema = z
  .object({ rating: z.number().int().min(1).max(5), body: z.string().max(2000).optional() })
  .openapi("ReviewCreate");
const ReviewReplySchema = z
  .object({ reply: z.string().min(1).max(2000) })
  .openapi("ReviewReply");
const SellerReviewsSchema = z
  .object({
    sellerId: z.string().uuid(),
    averageRating: z.number().nullable(),
    count: z.number().int(),
    reviews: z.array(ReviewSchema),
  })
  .openapi("SellerReviews");

type Row = {
  id: string;
  deal_id: string;
  reviewer_id: string;
  seller_id: string;
  rating: number;
  body: string | null;
  seller_reply: string | null;
  created_at: string | Date;
  replied_at: string | Date | null;
};
const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());
const isoN = (v: string | Date | null): string | null => (v == null ? null : iso(v));
function toReview(r: Row): z.infer<typeof ReviewSchema> {
  return {
    id: r.id,
    dealId: r.deal_id,
    reviewerId: r.reviewer_id,
    sellerId: r.seller_id,
    rating: r.rating,
    body: r.body,
    sellerReply: r.seller_reply,
    createdAt: iso(r.created_at),
    repliedAt: isoN(r.replied_at),
  };
}
const SELECT = `id, deal_id, reviewer_id, seller_id, rating, body, seller_reply, created_at, replied_at`;

export function registerReviews(app: OpenAPIHono<AuthEnv>) {
  // ── POST /deals/{id}/review — buyer reviews a completed deal ─────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/review",
      summary: "Buyer reviews a completed deal",
      tags: ["reviews"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ReviewCreateSchema } } },
      },
      responses: {
        201: { description: "Review posted", content: { "application/json": { schema: ReviewSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not reviewable / already reviewed", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [deal] = await db<{ buyer_id: string; seller_id: string; state: string }[]>`
        select buyer_id, seller_id, state from public.deals where id = ${id}
      `;
      if (!deal || deal.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);
      if (deal.state !== "COMPLETED") return c.json({ error: "deal_not_completed" }, 409);
      const [existing] = await db<{ id: string }[]>`select id from public.reviews where deal_id = ${id}`;
      if (existing) return c.json({ error: "already_reviewed" }, 409);

      try {
        const [row] = await db<Row[]>`
          insert into public.reviews (deal_id, reviewer_id, seller_id, rating, body)
          values (${id}, ${user.sub}, ${deal.seller_id}, ${b.rating}, ${b.body ?? null})
          returning ${db.unsafe(SELECT)}
        `;
        return c.json(toReview(row!), 201);
      } catch {
        // The DB gate is the guarantee — a race (deal changed, dup) lands here.
        return c.json({ error: "review_rejected" }, 409);
      }
    },
  );

  // ── POST /deals/{id}/review/reply — seller replies once ─────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/review/reply",
      summary: "Seller replies to a review (once)",
      tags: ["reviews"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ReviewReplySchema } } },
      },
      responses: {
        200: { description: "Reply posted", content: { "application/json": { schema: ReviewSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "No review / not the seller" },
        409: { description: "Already replied", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { reply } = c.req.valid("json");
      const [review] = await db<{ seller_id: string; seller_reply: string | null }[]>`
        select seller_id, seller_reply from public.reviews where deal_id = ${id}
      `;
      if (!review || review.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);
      if (review.seller_reply != null) return c.json({ error: "already_replied" }, 409);

      const [row] = await db<Row[]>`
        update public.reviews set seller_reply = ${reply}, replied_at = now()
        where deal_id = ${id} and seller_reply is null
        returning ${db.unsafe(SELECT)}
      `;
      if (!row) return c.json({ error: "already_replied" }, 409);
      return c.json(toReview(row), 200);
    },
  );

  // ── GET /deals/{id}/review — the review for a deal (public) ──────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}/review",
      summary: "The review for a deal",
      tags: ["reviews"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "The review", content: { "application/json": { schema: ReviewSchema } } },
        404: { description: "No review" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [row] = await db<Row[]>`select ${db.unsafe(SELECT)} from public.reviews where deal_id = ${id}`;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(toReview(row), 200);
    },
  );

  // ── GET /sellers/{id}/reviews — a seller's reviews + rating (public) ────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/sellers/{id}/reviews",
      summary: "A seller's reviews and average rating",
      tags: ["reviews"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Seller reviews", content: { "application/json": { schema: SellerReviewsSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.reviews where seller_id = ${id} order by created_at desc
      `;
      const count = rows.length;
      const averageRating =
        count === 0 ? null : Math.round((rows.reduce((s, r) => s + r.rating, 0) / count) * 10) / 10;
      return c.json({ sellerId: id, averageRating, count, reviews: rows.map(toReview) }, 200);
    },
  );
}
