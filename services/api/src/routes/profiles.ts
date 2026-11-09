import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, verifyAccessToken, type AuthEnv, type AuthUser } from "../middleware/auth.js";
import { getDb } from "../db.js";
import type { Sql } from "../deals/commands.js";
import { areaCentre, isState } from "../data/ng-regions.js";
import { createSignedUploadUrl, deleteStorageObject } from "../supabase.js";
import { AVATARS_BUCKET, avatarUrl } from "../profiles/summary.js";

/**
 * Phase 3 A — the user's own profile (20m / 20m-edit), notification and privacy
 * preferences (20m-notif / 20m-privacy), addresses (20m-addr), blocking, and the
 * public seller profile (21c). All writes are service-role through here; RLS only
 * guards the direct read path.
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

const NotificationPrefsSchema = z
  .object({
    channels: z
      .object({ push: z.boolean(), whatsapp: z.boolean(), email: z.boolean(), sms: z.boolean() })
      .openapi("NotificationChannels"),
    topics: z
      .object({ watch: z.boolean(), orders: z.boolean(), messages: z.boolean(), promotions: z.boolean() })
      .openapi("NotificationTopics"),
  })
  .openapi("NotificationPrefs");
type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

const DEFAULT_PREFS: NotificationPrefs = {
  channels: { push: true, whatsapp: false, email: false, sms: true },
  topics: { watch: true, orders: true, messages: true, promotions: false },
};

const MeSchema = z
  .object({
    userId: z.string(),
    phone: z.string().nullable(),
    displayName: z.string().nullable(),
    verificationLevel: z.number().int(),
    storeName: z.string().nullable(),
    bio: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    notificationPrefs: NotificationPrefsSchema,
    showLastSeen: z.boolean(),
    personaliseSearch: z.boolean(),
    memberSince: z.string(),
  })
  .openapi("Me");

const MeUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1).max(60).nullable(),
    storeName: z.string().trim().min(1).max(60).nullable(),
    bio: z.string().trim().max(160).nullable(),
    /** Both or neither; must be a canonical ng-regions pair (city may be null = whole state). */
    state: z.string().max(64).nullable(),
    city: z.string().max(64).nullable(),
    notificationPrefs: z
      .object({
        channels: NotificationPrefsSchema.shape.channels.partial().optional(),
        topics: NotificationPrefsSchema.shape.topics.partial().optional(),
      })
      .openapi("NotificationPrefsUpdate"),
    showLastSeen: z.boolean(),
    personaliseSearch: z.boolean(),
  })
  .partial()
  .openapi("MeUpdate");

const AvatarUploadRequestSchema = z
  .object({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]) })
  .openapi("AvatarUploadRequest");
const AvatarUploadSchema = z
  .object({ path: z.string(), uploadUrl: z.string() })
  .openapi("AvatarUpload");

const PublicProfileSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    storeName: z.string().nullable(),
    bio: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    verified: z.boolean(),
    memberSince: z.string(),
    /** Null when the user hides it (20m-privacy "Online / last seen"). */
    lastSeenAt: z.string().nullable(),
    averageRating: z.number().nullable(),
    reviewCount: z.number().int(),
    salesCount: z.number().int(),
    activeListingCount: z.number().int(),
    /** Whether the caller has blocked this user (false when signed out). */
    blockedByMe: z.boolean(),
  })
  .openapi("PublicProfile");

const AddressSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string(),
    line: z.string(),
    state: z.string().nullable(),
    city: z.string().nullable(),
    isDefault: z.boolean(),
    createdAt: z.string(),
  })
  .openapi("Address");

const AddressCreateSchema = z
  .object({
    label: z.string().trim().min(1).max(30),
    line: z.string().trim().min(1).max(200),
    state: z.string().max(64).nullable().optional(),
    city: z.string().max(64).nullable().optional(),
    isDefault: z.boolean().optional(),
  })
  .openapi("AddressCreate");

const AddressUpdateSchema = AddressCreateSchema.partial().openapi("AddressUpdate");

const BlockedUserSchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    storeName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    blockedAt: z.string(),
  })
  .openapi("BlockedUser");

const MAX_ADDRESSES = 10;

const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());

/** null = valid (or absent); otherwise the error code. City without state is invalid. */
function areaError(state: string | null | undefined, city: string | null | undefined): string | null {
  if (state == null) return city == null ? null : "invalid_area";
  if (!isState(state)) return "invalid_area";
  if (city != null && !areaCentre(state, city)) return "invalid_area";
  return null;
}

type ProfileRow = {
  phone: string | null;
  display_name: string | null;
  verification_level: number;
  store_name: string | null;
  bio: string | null;
  avatar_path: string | null;
  state: string | null;
  city: string | null;
  notification_prefs: NotificationPrefs | null;
  show_last_seen: boolean;
  personalise_search: boolean;
  created_at: string | Date;
};

const PROFILE_COLS = `phone, display_name, verification_level, store_name, bio, avatar_path,
  state, city, notification_prefs, show_last_seen, personalise_search, created_at`;

async function toMe(user: AuthUser, p: ProfileRow): Promise<z.infer<typeof MeSchema>> {
  const prefs = p.notification_prefs ?? DEFAULT_PREFS;
  return {
    userId: user.sub,
    phone: p.phone,
    displayName: p.display_name,
    verificationLevel: p.verification_level,
    storeName: p.store_name,
    bio: p.bio,
    avatarUrl: await avatarUrl(p.avatar_path),
    state: p.state,
    city: p.city,
    notificationPrefs: {
      channels: { ...DEFAULT_PREFS.channels, ...prefs.channels },
      topics: { ...DEFAULT_PREFS.topics, ...prefs.topics },
    },
    showLastSeen: p.show_last_seen,
    personaliseSearch: p.personalise_search,
    memberSince: iso(p.created_at),
  };
}

/** Upsert-on-first-sign-in, touching last_seen_at; returns the full row. */
async function ensureProfile(db: Sql, user: AuthUser): Promise<ProfileRow> {
  const rows = await db<ProfileRow[]>`
    insert into public.profiles (id, phone, last_seen_at)
    values (${user.sub}, ${user.phone}, now())
    on conflict (id) do update
      set updated_at = now(),
          last_seen_at = now(),
          phone = coalesce(public.profiles.phone, ${user.phone})
    returning ${db.unsafe(PROFILE_COLS)}
  `;
  return rows[0]!;
}

export function registerProfiles(app: OpenAPIHono<AuthEnv>) {
  // ── GET /me ─────────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me",
      summary: "The authenticated user's profile",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Current user", content: { "application/json": { schema: MeSchema } } },
        401: { description: "Missing or invalid token" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      return c.json(await toMe(user, await ensureProfile(db, user)), 200);
    },
  );

  // ── PATCH /me ───────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "patch",
      path: "/me",
      summary: "Update the authenticated user's profile and preferences",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: MeUpdateSchema } } } },
      responses: {
        200: { description: "Updated profile", content: { "application/json": { schema: MeSchema } } },
        400: { description: "Invalid area", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");
      const current = await ensureProfile(db, user);

      // Area is set as a pair: sending either key replaces both.
      const areaTouched = b.state !== undefined || b.city !== undefined;
      const state = areaTouched ? (b.state ?? null) : current.state;
      const city = areaTouched ? (b.city ?? null) : current.city;
      const err = areaError(state, city);
      if (err) return c.json({ error: err }, 400);

      const prefs = current.notification_prefs ?? DEFAULT_PREFS;
      const nextPrefs: NotificationPrefs = {
        channels: { ...DEFAULT_PREFS.channels, ...prefs.channels, ...(b.notificationPrefs?.channels ?? {}) },
        topics: { ...DEFAULT_PREFS.topics, ...prefs.topics, ...(b.notificationPrefs?.topics ?? {}) },
      };

      const pick = <T>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
      const rows = await db<ProfileRow[]>`
        update public.profiles set
          display_name       = ${pick(b.displayName, current.display_name)},
          store_name         = ${pick(b.storeName, current.store_name)},
          bio                = ${pick(b.bio || null, current.bio)},
          state              = ${state},
          city               = ${city},
          notification_prefs = ${db.json(nextPrefs)},
          show_last_seen     = ${pick(b.showLastSeen, current.show_last_seen)},
          personalise_search = ${pick(b.personaliseSearch, current.personalise_search)},
          updated_at         = now()
        where id = ${user.sub}
        returning ${db.unsafe(PROFILE_COLS)}
      `;
      return c.json(await toMe(user, rows[0]!), 200);
    },
  );

  // ── POST /me/avatar — signed upload URL; the path is attached now ───────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/me/avatar",
      summary: "Get a signed upload URL for a new profile photo",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: AvatarUploadRequestSchema } } } },
      responses: {
        200: { description: "PUT the image bytes to uploadUrl", content: { "application/json": { schema: AvatarUploadSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Storage/DB unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { contentType } = c.req.valid("json");
      const current = await ensureProfile(db, user);
      const path = `${user.sub}/${randomUUID()}.${IMAGE_TYPES[contentType]}`;
      const signed = await createSignedUploadUrl(AVATARS_BUCKET, path);
      if (!signed) return c.json({ error: "storage_unavailable" }, 503);
      await db`update public.profiles set avatar_path = ${path} where id = ${user.sub}`;
      if (current.avatar_path) await deleteStorageObject(AVATARS_BUCKET, current.avatar_path);
      return c.json({ path, uploadUrl: signed.uploadUrl }, 200);
    },
  );

  // ── DELETE /me/avatar ───────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/avatar",
      summary: "Remove the profile photo",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        204: { description: "Removed" },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const [old] = await db<{ avatar_path: string | null }[]>`
        update public.profiles p set avatar_path = null
        from (select avatar_path from public.profiles where id = ${user.sub}) prev
        where p.id = ${user.sub}
        returning prev.avatar_path
      `;
      if (old?.avatar_path) await deleteStorageObject(AVATARS_BUCKET, old.avatar_path);
      return c.body(null, 204);
    },
  );

  // ── GET /users/{id} — public seller profile (21c) ───────────────────────────
  // Auth is optional: signed-in callers also learn whether they've blocked this user.
  app.openapi(
    createRoute({
      method: "get",
      path: "/users/{id}",
      summary: "A user's public profile",
      tags: ["users"],
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Public profile", content: { "application/json": { schema: PublicProfileSchema } } },
        404: { description: "No such user" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const viewer = await optionalUserId(c.req.header("authorization"));

      // Keyed on auth.users, not profiles: a profile row only exists once the user has
      // called GET /me, but every account is a real person others may look up.
      const [p] = await db<
        {
          display_name: string | null; store_name: string | null; bio: string | null; avatar_path: string | null;
          state: string | null; city: string | null; verification_level: number | null; show_last_seen: boolean | null;
          member_since: string | Date; last_seen_at: string | Date | null;
          avg: string | null; review_count: number; sales: number; active: number; blocked_by_me: boolean;
        }[]
      >`
        select p.display_name, p.store_name, p.bio, p.avatar_path, p.state, p.city,
          p.verification_level, p.show_last_seen, p.last_seen_at,
          coalesce(p.created_at, u.created_at) as member_since,
          (select avg(rating)::numeric(3,1) from public.reviews where seller_id = u.id) as avg,
          (select count(*)::int from public.reviews where seller_id = u.id) as review_count,
          (select count(*)::int from public.deals where seller_id = u.id and state = 'COMPLETED') as sales,
          (select count(*)::int from public.listings where seller_id = u.id and status = 'active') as active,
          exists (select 1 from public.blocks where blocker_id = ${viewer} and blocked_id = u.id) as blocked_by_me
        from auth.users u left join public.profiles p on p.id = u.id
        where u.id = ${id}
      `;
      if (!p) return c.json({ error: "not_found" }, 404);
      return c.json(
        {
          id,
          displayName: p.display_name,
          storeName: p.store_name,
          bio: p.bio,
          avatarUrl: await avatarUrl(p.avatar_path),
          state: p.state,
          city: p.city,
          verified: (p.verification_level ?? 1) >= 2,
          memberSince: iso(p.member_since),
          lastSeenAt: (p.show_last_seen ?? true) && p.last_seen_at ? iso(p.last_seen_at) : null,
          averageRating: p.avg == null ? null : Number(p.avg),
          reviewCount: p.review_count,
          salesCount: p.sales,
          activeListingCount: p.active,
          blockedByMe: p.blocked_by_me,
        },
        200,
      );
    },
  );

  // ── Addresses (20m-addr) ────────────────────────────────────────────────────
  type AddressRow = { id: string; label: string; line: string; state: string | null; city: string | null; is_default: boolean; created_at: string | Date };
  const toAddress = (r: AddressRow) => ({
    id: r.id, label: r.label, line: r.line, state: r.state, city: r.city, isDefault: r.is_default, createdAt: iso(r.created_at),
  });
  const ADDR_COLS = `id, label, line, state, city, is_default, created_at`;

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/addresses",
      summary: "The user's saved addresses (default first)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Addresses", content: { "application/json": { schema: z.array(AddressSchema) } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<AddressRow[]>`
        select ${db.unsafe(ADDR_COLS)} from public.addresses
        where user_id = ${user.sub} order by is_default desc, created_at
      `;
      return c.json(rows.map(toAddress), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/addresses",
      summary: "Add an address (the first one becomes the default)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: AddressCreateSchema } } } },
      responses: {
        201: { description: "Created", content: { "application/json": { schema: AddressSchema } } },
        400: { description: "Invalid area", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "Address limit reached", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");
      const err = areaError(b.state, b.city);
      if (err) return c.json({ error: err }, 400);
      const result = await db.begin(async (sql) => {
        // Serialise per user so the count check and default flip can't race.
        await sql`select pg_advisory_xact_lock(hashtext(${"addresses:" + user.sub}))`;
        const [{ n } = { n: 0 }] = await sql<{ n: number }[]>`
          select count(*)::int as n from public.addresses where user_id = ${user.sub}
        `;
        if (n >= MAX_ADDRESSES) return null;
        const makeDefault = n === 0 || b.isDefault === true;
        if (makeDefault) await sql`update public.addresses set is_default = false where user_id = ${user.sub} and is_default`;
        const [row] = await sql<AddressRow[]>`
          insert into public.addresses (user_id, label, line, state, city, is_default)
          values (${user.sub}, ${b.label}, ${b.line}, ${b.state ?? null}, ${b.city ?? null}, ${makeDefault})
          returning ${sql.unsafe(ADDR_COLS)}
        `;
        return row!;
      });
      if (!result) return c.json({ error: "address_limit_reached" }, 409);
      return c.json(toAddress(result), 201);
    },
  );

  app.openapi(
    createRoute({
      method: "patch",
      path: "/me/addresses/{id}",
      summary: "Edit an address, or make it the default",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: AddressUpdateSchema } } },
      },
      responses: {
        200: { description: "Updated", content: { "application/json": { schema: AddressSchema } } },
        400: { description: "Invalid area", content: { "application/json": { schema: ErrorSchema } } },
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
      const b = c.req.valid("json");
      const row = await db.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtext(${"addresses:" + user.sub}))`;
        const [cur] = await sql<AddressRow[]>`
          select ${sql.unsafe(ADDR_COLS)} from public.addresses where id = ${id} and user_id = ${user.sub}
        `;
        if (!cur) return "not_found" as const;
        const areaTouched = b.state !== undefined || b.city !== undefined;
        const state = areaTouched ? (b.state ?? null) : cur.state;
        const city = areaTouched ? (b.city ?? null) : cur.city;
        if (areaError(state, city)) return "invalid_area" as const;
        // Unsetting the only default isn't offered: a default moves, it doesn't vanish.
        if (b.isDefault === true && !cur.is_default)
          await sql`update public.addresses set is_default = false where user_id = ${user.sub} and is_default`;
        const [next] = await sql<AddressRow[]>`
          update public.addresses set
            label = ${b.label ?? cur.label},
            line = ${b.line ?? cur.line},
            state = ${state},
            city = ${city},
            is_default = ${b.isDefault === true ? true : cur.is_default}
          where id = ${id} and user_id = ${user.sub}
          returning ${sql.unsafe(ADDR_COLS)}
        `;
        return next!;
      });
      if (row === "not_found") return c.json({ error: "not_found" }, 404);
      if (row === "invalid_area") return c.json({ error: "invalid_area" }, 400);
      return c.json(toAddress(row), 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me/addresses/{id}",
      summary: "Remove an address (the oldest remaining one becomes default)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "Removed" },
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
      const found = await db.begin(async (sql) => {
        await sql`select pg_advisory_xact_lock(hashtext(${"addresses:" + user.sub}))`;
        const [gone] = await sql<{ is_default: boolean }[]>`
          delete from public.addresses where id = ${id} and user_id = ${user.sub} returning is_default
        `;
        if (!gone) return false;
        if (gone.is_default) {
          await sql`
            update public.addresses set is_default = true
            where id = (select id from public.addresses where user_id = ${user.sub} order by created_at limit 1)
          `;
        }
        return true;
      });
      if (!found) return c.json({ error: "not_found" }, 404);
      return c.body(null, 204);
    },
  );

  // ── Blocking (20m-privacy "Blocked people") ─────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/blocks",
      summary: "People the user has blocked",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Blocked users", content: { "application/json": { schema: z.array(BlockedUserSchema) } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const rows = await db<
        { blocked_id: string; created_at: string | Date; display_name: string | null; store_name: string | null; avatar_path: string | null }[]
      >`
        select b.blocked_id, b.created_at, p.display_name, p.store_name, p.avatar_path
        from public.blocks b left join public.profiles p on p.id = b.blocked_id
        where b.blocker_id = ${user.sub} order by b.created_at desc
      `;
      return c.json(
        await Promise.all(
          rows.map(async (r) => ({
            id: r.blocked_id,
            displayName: r.display_name,
            storeName: r.store_name,
            avatarUrl: await avatarUrl(r.avatar_path),
            blockedAt: iso(r.created_at),
          })),
        ),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/users/{id}/block",
      summary: "Block a user (they can no longer message you)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "Blocked (idempotent)" },
        400: { description: "Cannot block yourself", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "No such user" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      if (id === user.sub) return c.json({ error: "cannot_block_self" }, 400);
      const [exists] = await db<{ ok: boolean }[]>`select exists (select 1 from auth.users where id = ${id}) as ok`;
      if (!exists?.ok) return c.json({ error: "not_found" }, 404);
      await db`
        insert into public.blocks (blocker_id, blocked_id) values (${user.sub}, ${id})
        on conflict do nothing
      `;
      return c.body(null, 204);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/users/{id}/block",
      summary: "Unblock a user",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        204: { description: "Unblocked (idempotent)" },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      await db`delete from public.blocks where blocker_id = ${user.sub} and blocked_id = ${id}`;
      return c.body(null, 204);
    },
  );
}

/**
 * Resolve the caller's user id from an optional bearer token, for public routes that
 * personalise when signed in. Any failure means "anonymous", never an error.
 */
async function optionalUserId(header: string | undefined): Promise<string | null> {
  if (!header?.startsWith("Bearer ")) return null;
  return (await verifyAccessToken(header.slice(7)))?.sub ?? null;
}
