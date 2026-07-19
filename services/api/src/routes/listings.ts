import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import {
  LISTING_IMAGES_BUCKET,
  createSignedDownloadUrl,
  createSignedUploadUrl,
} from "../supabase.js";

/**
 * M1 — Goods listings + Storage. CRUD through the service-role API (business
 * rules in one auditable place); images live in the private `listing-images`
 * bucket, reached only via short-lived signed URLs the API mints. `lane` and
 * `category` stay separate; M1 is Goods-only (the DB CHECKs lane='goods').
 */

const CONDITIONS = ["new", "used", "refurbished"] as const;
const STATUSES = ["draft", "active", "sold", "archived"] as const;
const IMAGE_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
} as const;

// ── Schemas (all named → clean TS/Kotlin/Swift codegen) ──────────────────────
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const ListingSchema = z
  .object({
    id: z.string().uuid(),
    sellerId: z.string().uuid(),
    lane: z.literal("goods"),
    category: z.string(),
    title: z.string(),
    description: z.string().nullable(),
    priceKobo: z.number().int().nonnegative(),
    currency: z.literal("NGN"),
    negotiable: z.boolean(),
    stock: z.number().int().nonnegative(),
    condition: z.enum(CONDITIONS),
    location: z.string().nullable(),
    status: z.enum(STATUSES),
    imageUrls: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi("Listing");

const ListingCreateSchema = z
  .object({
    category: z.string().min(1).max(64),
    title: z.string().min(1).max(140),
    description: z.string().max(4000).optional(),
    priceKobo: z.number().int().nonnegative(),
    negotiable: z.boolean().optional(),
    stock: z.number().int().nonnegative().optional(),
    condition: z.enum(CONDITIONS).optional(),
    location: z.string().max(120).optional(),
  })
  .openapi("ListingCreate");

const ListingUpdateSchema = z
  .object({
    category: z.string().min(1).max(64).optional(),
    title: z.string().min(1).max(140).optional(),
    description: z.string().max(4000).nullable().optional(),
    priceKobo: z.number().int().nonnegative().optional(),
    negotiable: z.boolean().optional(),
    stock: z.number().int().nonnegative().optional(),
    condition: z.enum(CONDITIONS).optional(),
    location: z.string().max(120).nullable().optional(),
    status: z.enum(STATUSES).optional(),
  })
  .openapi("ListingUpdate");

const ListingPageSchema = z
  .object({
    items: z.array(ListingSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi("ListingPage");

const ImageUploadRequestSchema = z
  .object({
    contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  })
  .openapi("ImageUploadRequest");

const ImageUploadSchema = z
  .object({ path: z.string(), uploadUrl: z.string() })
  .openapi("ImageUpload");

// Raw DB shape (bigint arrives as string from postgres.js).
type Row = {
  id: string;
  seller_id: string;
  lane: string;
  category: string;
  title: string;
  description: string | null;
  price_kobo: string | number;
  currency: string;
  negotiable: boolean;
  stock: number;
  condition: (typeof CONDITIONS)[number];
  location: string | null;
  image_paths: string[];
  status: (typeof STATUSES)[number];
  created_at: string | Date;
  updated_at: string | Date;
};

const iso = (v: string | Date): string =>
  typeof v === "string" ? v : v.toISOString();

/** Map a row to the API shape, signing a download URL for each stored image. */
async function toListing(r: Row): Promise<z.infer<typeof ListingSchema>> {
  const imageUrls = (
    await Promise.all(
      (r.image_paths ?? []).map((p) =>
        createSignedDownloadUrl(LISTING_IMAGES_BUCKET, p),
      ),
    )
  ).filter((u): u is string => !!u);

  return {
    id: r.id,
    sellerId: r.seller_id,
    lane: "goods",
    category: r.category,
    title: r.title,
    description: r.description,
    priceKobo: Number(r.price_kobo),
    currency: "NGN",
    negotiable: r.negotiable,
    stock: r.stock,
    condition: r.condition,
    location: r.location,
    status: r.status,
    imageUrls,
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

const SELECT = `id, seller_id, lane, category, title, description, price_kobo,
  currency, negotiable, stock, condition, location, image_paths, status,
  created_at, updated_at`;

export function registerListings(app: OpenAPIHono<AuthEnv>) {
  // ── POST /listings ─────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings",
      summary: "Create a Goods listing",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        body: {
          content: { "application/json": { schema: ListingCreateSchema } },
        },
      },
      responses: {
        201: {
          description: "Created",
          content: { "application/json": { schema: ListingSchema } },
        },
        401: { description: "Unauthorized" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");

      const rows = await db<Row[]>`
        insert into public.listings
          (seller_id, category, title, description, price_kobo, negotiable, stock, condition, location)
        values (
          ${user.sub}, ${b.category}, ${b.title}, ${b.description ?? null},
          ${b.priceKobo}, ${b.negotiable ?? true}, ${b.stock ?? 1},
          ${b.condition ?? "used"}, ${b.location ?? null}
        )
        returning ${db.unsafe(SELECT)}
      `;
      return c.json(await toListing(rows[0]!), 201);
    },
  );

  // ── GET /listings — public browse (newest active first, keyset) ─────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings",
      summary: "Browse active listings",
      tags: ["listings"],
      request: {
        query: z.object({
          limit: z.coerce.number().int().min(1).max(50).optional(),
          cursor: z.string().datetime().optional(),
        }),
      },
      responses: {
        200: {
          description: "A page of active listings",
          content: { "application/json": { schema: ListingPageSchema } },
        },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { limit, cursor } = c.req.valid("query");
      const take = limit ?? 20;

      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where status = 'active'
          ${cursor ? db`and created_at < ${cursor}` : db``}
        order by created_at desc
        limit ${take}
      `;
      const items = await Promise.all(rows.map(toListing));
      const nextCursor =
        rows.length === take ? iso(rows[rows.length - 1]!.created_at) : null;
      return c.json({ items, nextCursor }, 200);
    },
  );

  // ── GET /listings/mine — the caller's own listings (incl. drafts) ───────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/mine",
      summary: "The caller's own listings",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: {
          description: "The caller's listings",
          content: { "application/json": { schema: z.array(ListingSchema) } },
        },
        401: { description: "Unauthorized" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where seller_id = ${user.sub}
        order by created_at desc
      `;
      return c.json(await Promise.all(rows.map(toListing)), 200);
    },
  );

  // ── GET /listings/{id} — public read of an active listing ───────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/listings/{id}",
      summary: "Read an active listing",
      tags: ["listings"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: {
          description: "The listing",
          content: { "application/json": { schema: ListingSchema } },
        },
        404: { description: "Not found" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const rows = await db<Row[]>`
        select ${db.unsafe(SELECT)} from public.listings
        where id = ${id} and status = 'active'
      `;
      if (!rows[0]) return c.json({ error: "not_found" }, 404);
      return c.json(await toListing(rows[0]), 200);
    },
  );

  // ── PATCH /listings/{id} — edit own listing ─────────────────────────────────
  app.openapi(
    createRoute({
      method: "patch",
      path: "/listings/{id}",
      summary: "Edit own listing",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ListingUpdateSchema } } },
      },
      responses: {
        200: {
          description: "Updated",
          content: { "application/json": { schema: ListingSchema } },
        },
        401: { description: "Unauthorized" },
        404: { description: "Not found or not owner" },
        503: {
          description: "Database unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");

      // Only the columns present in the body; map API → column names.
      const cols: Record<string, unknown> = {};
      if (b.category !== undefined) cols.category = b.category;
      if (b.title !== undefined) cols.title = b.title;
      if (b.description !== undefined) cols.description = b.description;
      if (b.priceKobo !== undefined) cols.price_kobo = b.priceKobo;
      if (b.negotiable !== undefined) cols.negotiable = b.negotiable;
      if (b.stock !== undefined) cols.stock = b.stock;
      if (b.condition !== undefined) cols.condition = b.condition;
      if (b.location !== undefined) cols.location = b.location;
      if (b.status !== undefined) cols.status = b.status;

      if (Object.keys(cols).length === 0) {
        // Nothing to change — return the current row (owner-scoped).
        const rows = await db<Row[]>`
          select ${db.unsafe(SELECT)} from public.listings
          where id = ${id} and seller_id = ${user.sub}
        `;
        if (!rows[0]) return c.json({ error: "not_found" }, 404);
        return c.json(await toListing(rows[0]), 200);
      }

      const rows = await db<Row[]>`
        update public.listings set ${db(cols)}
        where id = ${id} and seller_id = ${user.sub}
        returning ${db.unsafe(SELECT)}
      `;
      if (!rows[0]) return c.json({ error: "not_found" }, 404);
      return c.json(await toListing(rows[0]), 200);
    },
  );

  // ── POST /listings/{id}/images — mint a signed upload URL, attach the path ──
  app.openapi(
    createRoute({
      method: "post",
      path: "/listings/{id}/images",
      summary: "Get a signed upload URL for a listing image",
      tags: ["listings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ImageUploadRequestSchema } } },
      },
      responses: {
        200: {
          description: "Signed upload URL (PUT the image bytes to it)",
          content: { "application/json": { schema: ImageUploadSchema } },
        },
        401: { description: "Unauthorized" },
        404: { description: "Not found or not owner" },
        409: {
          description: "Image limit reached",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: {
          description: "Storage/DB unavailable",
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { contentType } = c.req.valid("json");

      const owned = await db<{ image_paths: string[] }[]>`
        select image_paths from public.listings
        where id = ${id} and seller_id = ${user.sub}
      `;
      if (!owned[0]) return c.json({ error: "not_found" }, 404);
      if ((owned[0].image_paths?.length ?? 0) >= 10)
        return c.json({ error: "image_limit_reached" }, 409);

      const ext = IMAGE_TYPES[contentType];
      const path = `${user.sub}/${id}/${randomUUID()}.${ext}`;
      const signed = await createSignedUploadUrl(LISTING_IMAGES_BUCKET, path);
      if (!signed) return c.json({ error: "storage_unavailable" }, 503);

      // Attach the path now; a failed upload leaves a dangling key (swept later).
      await db`
        update public.listings
        set image_paths = array_append(image_paths, ${path})
        where id = ${id} and seller_id = ${user.sub}
      `;
      return c.json({ path, uploadUrl: signed.uploadUrl }, 200);
    },
  );
}
