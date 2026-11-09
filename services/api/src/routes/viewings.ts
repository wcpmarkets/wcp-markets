import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import type { Sql } from "../deals/commands.js";
import { isBlockedEitherWay } from "../profiles/summary.js";

/**
 * Phase 3 C — logged viewings (migration 0024; design 22b-enquiry "Viewing logged").
 *
 * In lead-gen lanes the buyer inspects in person — so WCP keeps the agreed time and
 * place on file for safety. One live viewing per conversation: either party proposes
 * (which supersedes any open one), the OTHER party confirms, either party cancels.
 * Writes go through here; the two parties can also read `viewings` via Realtime (RLS).
 */

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

/** How far ahead a viewing can be booked. */
export const MAX_DAYS_AHEAD = 90;

export const ViewingSchema = z
  .object({
    id: z.string().uuid(),
    conversationId: z.string().uuid(),
    proposedBy: z.string().uuid(),
    startsAt: z.string(),
    endsAt: z.string().nullable(),
    place: z.string(),
    note: z.string().nullable(),
    status: z.enum(["proposed", "confirmed", "cancelled", "superseded"]),
    confirmedAt: z.string().nullable(),
    cancelledBy: z.string().uuid().nullable(),
    createdAt: z.string(),
  })
  .openapi("Viewing");

const ViewingCreateSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    /** Optional end of a window ("Sat 10–4"); at most 12 hours after the start. */
    endsAt: z.string().datetime({ offset: true }).optional(),
    place: z.string().trim().min(1).max(200),
    note: z.string().trim().max(500).optional(),
  })
  .openapi("ViewingCreate");

export type ViewingRow = {
  id: string;
  conversation_id: string;
  proposed_by: string;
  starts_at: string | Date;
  ends_at: string | Date | null;
  place: string;
  note: string | null;
  status: "proposed" | "confirmed" | "cancelled" | "superseded";
  confirmed_at: string | Date | null;
  cancelled_by: string | null;
  created_at: string | Date;
};

// Rows arrive either from a typed select (Date) or from to_jsonb (ISO-ish string).
const iso = (v: string | Date): string => new Date(v).toISOString();

export const toViewing = (v: ViewingRow) => ({
  id: v.id,
  conversationId: v.conversation_id,
  proposedBy: v.proposed_by,
  startsAt: iso(v.starts_at),
  endsAt: v.ends_at ? iso(v.ends_at) : null,
  place: v.place,
  note: v.note,
  status: v.status,
  confirmedAt: v.confirmed_at ? iso(v.confirmed_at) : null,
  cancelledBy: v.cancelled_by,
  createdAt: iso(v.created_at),
});

const COLS = `id, conversation_id, proposed_by, starts_at, ends_at, place, note, status,
  confirmed_at, cancelled_by, created_at`;

type Party = { buyer_id: string; seller_id: string };

async function partyConversation(db: Sql, me: string, id: string): Promise<Party | null> {
  const [conv] = await db<Party[]>`
    select buyer_id, seller_id from public.conversations
    where id = ${id} and ${me} in (buyer_id, seller_id)
  `;
  return conv ?? null;
}

const common = {
  401: { description: "Unauthorized" },
  404: { description: "Not found" },
  503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
} as const;

export function registerViewings(app: OpenAPIHono<AuthEnv>) {
  // ── GET /conversations/{id}/viewings — history, newest first ────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/conversations/{id}/viewings",
      summary: "Viewings logged in a conversation (party only), newest first",
      tags: ["viewings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Viewings", content: { "application/json": { schema: z.array(ViewingSchema) } } },
        ...common,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      if (!(await partyConversation(db, user.sub, id))) return c.json({ error: "not_found" }, 404);
      const rows = await db<ViewingRow[]>`
        select ${db.unsafe(COLS)} from public.viewings
        where conversation_id = ${id} order by created_at desc limit 50
      `;
      return c.json(rows.map(toViewing), 200);
    },
  );

  // ── POST /conversations/{id}/viewings — propose (supersedes the open one) ───
  app.openapi(
    createRoute({
      method: "post",
      path: "/conversations/{id}/viewings",
      summary: "Propose a viewing time and place; replaces any live viewing in the thread",
      tags: ["viewings"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "viewing", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: ViewingCreateSchema } } },
      },
      responses: {
        201: { description: "Proposed", content: { "application/json": { schema: ViewingSchema } } },
        403: { description: "Blocked", content: { "application/json": { schema: ErrorSchema } } },
        422: {
          description: "Start in the past or too far ahead, or a bad window",
          content: { "application/json": { schema: ErrorSchema } },
        },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        ...common,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const conv = await partyConversation(db, user.sub, id);
      if (!conv) return c.json({ error: "not_found" }, 404);
      if (await isBlockedEitherWay(db, conv.buyer_id, conv.seller_id)) return c.json({ error: "blocked" }, 403);

      const starts = new Date(b.startsAt);
      const ends = b.endsAt ? new Date(b.endsAt) : null;
      const now = Date.now();
      if (starts.getTime() <= now) return c.json({ error: "starts_in_past" }, 422);
      if (starts.getTime() > now + MAX_DAYS_AHEAD * 86_400_000) return c.json({ error: "too_far_ahead" }, 422);
      if (ends && (ends <= starts || ends.getTime() - starts.getTime() > 12 * 3_600_000)) {
        return c.json({ error: "invalid_window" }, 422);
      }

      const row = await db.begin(async (tx) => {
        const t = tx as unknown as Sql;
        // Serialise proposals on this thread, then retire the live one.
        await t`select id from public.conversations where id = ${id} for update`;
        await t`
          update public.viewings set status = 'superseded', updated_at = now()
          where conversation_id = ${id} and status in ('proposed', 'confirmed')
        `;
        const [v] = await t<ViewingRow[]>`
          insert into public.viewings (conversation_id, proposed_by, starts_at, ends_at, place, note)
          values (${id}, ${user.sub}, ${starts}, ${ends}, ${b.place}, ${b.note ?? null})
          returning ${t.unsafe(COLS)}
        `;
        return v!;
      });
      return c.json(toViewing(row), 201);
    },
  );

  // ── POST /viewings/{id}/confirm — the other party agrees ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/viewings/{id}/confirm",
      summary: "Confirm a proposed viewing (the party who did NOT propose it)",
      tags: ["viewings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Confirmed", content: { "application/json": { schema: ViewingSchema } } },
        403: { description: "Own proposal, or blocked", content: { "application/json": { schema: ErrorSchema } } },
        409: { description: "Not open for confirmation", content: { "application/json": { schema: ErrorSchema } } },
        ...common,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [v] = await db<(ViewingRow & Party)[]>`
        select v.proposed_by, v.status, c.buyer_id, c.seller_id
        from public.viewings v join public.conversations c on c.id = v.conversation_id
        where v.id = ${id} and ${user.sub} in (c.buyer_id, c.seller_id)
      `;
      if (!v) return c.json({ error: "not_found" }, 404);
      if (v.proposed_by === user.sub) return c.json({ error: "own_proposal" }, 403);
      if (await isBlockedEitherWay(db, v.buyer_id, v.seller_id)) return c.json({ error: "blocked" }, 403);
      if (v.status !== "proposed") return c.json({ error: "not_proposed" }, 409);
      const [row] = await db<ViewingRow[]>`
        update public.viewings set status = 'confirmed', confirmed_at = now(), updated_at = now()
        where id = ${id} and status = 'proposed'
        returning ${db.unsafe(COLS)}
      `;
      if (!row) return c.json({ error: "not_proposed" }, 409);
      return c.json(toViewing(row), 200);
    },
  );

  // ── POST /viewings/{id}/cancel — either party ───────────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/viewings/{id}/cancel",
      summary: "Cancel a live viewing (either party)",
      tags: ["viewings"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Cancelled", content: { "application/json": { schema: ViewingSchema } } },
        409: { description: "Already cancelled or replaced", content: { "application/json": { schema: ErrorSchema } } },
        ...common,
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [row] = await db<ViewingRow[]>`
        update public.viewings v set status = 'cancelled', cancelled_by = ${user.sub}, updated_at = now()
        from public.conversations c
        where v.id = ${id} and c.id = v.conversation_id and ${user.sub} in (c.buyer_id, c.seller_id)
          and v.status in ('proposed', 'confirmed')
        returning ${db.unsafe(COLS.split(",").map((x) => "v." + x.trim()).join(", "))}
      `;
      if (row) return c.json(toViewing(row), 200);
      const [exists] = await db`
        select 1 from public.viewings v join public.conversations c on c.id = v.conversation_id
        where v.id = ${id} and ${user.sub} in (c.buyer_id, c.seller_id)
      `;
      return exists ? c.json({ error: "not_live" }, 409) : c.json({ error: "not_found" }, 404);
    },
  );
}
