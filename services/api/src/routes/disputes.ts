import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { ownedPaths, photoUrls, PhotoPathsSchema } from "./attachments.js";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { transition } from "../deals/commands.js";
import { isStaffAdmin } from "../deals/admin.js";
import { userSummaries, UserSummarySchema } from "../profiles/summary.js";
import { LISTING_IMAGES_BUCKET, createSignedDownloadUrl } from "../supabase.js";

/**
 * M6 — disputes. A buyer opens a dispute (→ DISPUTED, 24h auto-refund clock); the
 * seller responds (→ DISPUTED_RESPONDED, clock stops); a CX/support ADMIN resolves
 * (release to seller or refund buyer). dispute_cases is the support view; the deal
 * state machine + deal_events remain the atomic source of truth.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const DisputeCaseSchema = z
  .object({
    dealId: z.string().uuid(),
    openedBy: z.string().uuid(),
    reason: z.string(),
    buyerEvidence: z.string().nullable(),
    sellerResponse: z.string().nullable(),
    sellerEvidence: z.string().nullable(),
    /** Signed (1h) URLs of the photos each side attached. */
    buyerPhotoUrls: z.array(z.string()),
    sellerPhotoUrls: z.array(z.string()),
    status: z.enum(["open", "responded", "resolved"]),
    resolution: z.enum(["release", "refund"]).nullable(),
    resolvedBy: z.string().uuid().nullable(),
    resolutionNote: z.string().nullable(),
    createdAt: z.string(),
    respondedAt: z.string().nullable(),
    resolvedAt: z.string().nullable(),
  })
  .openapi("DisputeCase");

const DisputeOpenSchema = z
  .object({ reason: z.string().min(1).max(2000), evidence: z.string().max(4000).optional(), photoPaths: PhotoPathsSchema.optional() })
  .openapi("DisputeOpen");
const DisputeRespondSchema = z
  .object({ response: z.string().min(1).max(2000), evidence: z.string().max(4000).optional(), photoPaths: PhotoPathsSchema.optional() })
  .openapi("DisputeRespond");
const DisputeResolveSchema = z
  .object({ resolution: z.enum(["release", "refund"]), note: z.string().max(2000).optional() })
  .openapi("DisputeResolve");

// The support queue is driven by the AUTHORITATIVE deal state (a dispute is never
// lost from view even if its case row write failed); the case fields are display
// data (nullable). buyerDisputes30d surfaces a serial-disputer at decision time.
const DisputeQueueItemSchema = z
  .object({
    dealId: z.string().uuid(),
    dealState: z.string(),
    buyerId: z.string().uuid(),
    sellerId: z.string().uuid(),
    status: z.enum(["open", "responded", "resolved"]).nullable(),
    reason: z.string().nullable(),
    openedBy: z.string().uuid().nullable(),
    createdAt: z.string().nullable(),
    respondedAt: z.string().nullable(),
    buyerDisputes30d: z.number().int(),
    listingTitle: z.string().nullable(),
    /** Agreed unit price × quantity — what escrow holds for the item (fees aside). */
    principalKobo: z.number().int(),
    buyer: UserSummarySchema,
    seller: UserSummarySchema,
  })
  .openapi("DisputeQueueItem");

const AdminDealEventSchema = z
  .object({
    seq: z.number().int(),
    actor: z.string(),
    action: z.string(),
    fromState: z.string().nullable(),
    toState: z.string(),
    priceKobo: z.number().int().nullable(),
    reason: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("AdminDealEvent");

const AdminMessageSchema = z
  .object({ id: z.number().int(), senderId: z.string().uuid(), body: z.string(), createdAt: z.string() })
  .openapi("AdminMessage");

/** Everything staff need to decide a dispute: the case, the deal, its timeline and chat. */
const DisputeDetailSchema = z
  .object({
    case: DisputeCaseSchema.nullable(),
    deal: z
      .object({ id: z.string().uuid(), state: z.string(), priceKobo: z.number().int(), qty: z.number().int(), createdAt: z.string() })
      .openapi("AdminDeal"),
    listing: z
      .object({ id: z.string().uuid(), title: z.string(), lane: z.string(), status: z.string(), imageUrl: z.string().nullable() })
      .nullable()
      .openapi("AdminDealListing"),
    buyer: UserSummarySchema,
    seller: UserSummarySchema,
    buyerDisputes30d: z.number().int(),
    events: z.array(AdminDealEventSchema),
    /** The buyer–seller thread on this listing, oldest first (last 200). */
    messages: z.array(AdminMessageSchema),
  })
  .openapi("DisputeDetail");

type CaseRow = {
  deal_id: string;
  opened_by: string;
  reason: string;
  buyer_evidence: string | null;
  seller_response: string | null;
  seller_evidence: string | null;
  buyer_photo_paths: string[] | null;
  seller_photo_paths: string[] | null;
  status: "open" | "responded" | "resolved";
  resolution: "release" | "refund" | null;
  resolved_by: string | null;
  resolution_note: string | null;
  created_at: string | Date;
  responded_at: string | Date | null;
  resolved_at: string | Date | null;
};
const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());
const isoN = (v: string | Date | null): string | null => (v == null ? null : iso(v));
async function toCase(r: CaseRow): Promise<z.infer<typeof DisputeCaseSchema>> {
  const [buyerPhotoUrls, sellerPhotoUrls] = await Promise.all([photoUrls(r.buyer_photo_paths), photoUrls(r.seller_photo_paths)]);
  return {
    buyerPhotoUrls,
    sellerPhotoUrls,
    dealId: r.deal_id,
    openedBy: r.opened_by,
    reason: r.reason,
    buyerEvidence: r.buyer_evidence,
    sellerResponse: r.seller_response,
    sellerEvidence: r.seller_evidence,
    status: r.status,
    resolution: r.resolution,
    resolvedBy: r.resolved_by,
    resolutionNote: r.resolution_note,
    createdAt: iso(r.created_at),
    respondedAt: isoN(r.responded_at),
    resolvedAt: isoN(r.resolved_at),
  };
}
// If a case row is (rarely) missing because its write lost the crash-window race
// after the authoritative transition committed, return a degraded stub rather than
// 500 — the deal state machine + deal_events remain the source of truth.
function stubCase(
  dealId: string,
  patch: Partial<z.infer<typeof DisputeCaseSchema>>,
): z.infer<typeof DisputeCaseSchema> {
  return {
    dealId,
    openedBy: dealId,
    reason: "(case record unavailable — see deal events)",
    buyerEvidence: null,
    sellerResponse: null,
    sellerEvidence: null,
    buyerPhotoUrls: [],
    sellerPhotoUrls: [],
    status: "open",
    resolution: null,
    resolvedBy: null,
    resolutionNote: null,
    createdAt: new Date().toISOString(),
    respondedAt: null,
    resolvedAt: null,
    ...patch,
  };
}

const idem = (c: { req: { header: (n: string) => string | undefined } }) =>
  c.req.header("idempotency-key") ?? undefined;
const SELECT = `deal_id, opened_by, reason, buyer_evidence, seller_response, seller_evidence, buyer_photo_paths, seller_photo_paths,
  status, resolution, resolved_by, resolution_note, created_at, responded_at, resolved_at`;

export function registerDisputes(app: OpenAPIHono<AuthEnv>) {
  // ── POST /deals/{id}/dispute — buyer opens a dispute ────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/dispute",
      summary: "Buyer opens a dispute on a paid/handed-off deal",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DisputeOpenSchema } } },
      },
      responses: {
        201: { description: "Dispute opened", content: { "application/json": { schema: DisputeCaseSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not disputable in this state", content: { "application/json": { schema: ErrorSchema } } },
        422: { description: "A photo that isn't yours (bad_photo)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || deal.buyer_id !== user.sub) return c.json({ error: "not_found" }, 404);
      const photos = ownedPaths(user.sub, b.photoPaths);
      if (!photos) return c.json({ error: "bad_photo" }, 422);

      const r = await transition(db, {
        dealId: id,
        actor: "BUYER",
        actorId: user.sub,
        action: "dispute",
        reason: b.reason.slice(0, 200),
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_disputable" : "conflict" }, 409);
      }
      const [row] = await db<CaseRow[]>`
        insert into public.dispute_cases (deal_id, opened_by, reason, buyer_evidence, buyer_photo_paths)
        values (${id}, ${user.sub}, ${b.reason}, ${b.evidence ?? null}, ${photos})
        on conflict (deal_id) do update set reason = excluded.reason, buyer_evidence = excluded.buyer_evidence,
          buyer_photo_paths = excluded.buyer_photo_paths
        returning ${db.unsafe(SELECT)}
      `;
      return c.json(await toCase(row!), 201);
    },
  );

  // ── POST /deals/{id}/dispute/respond — seller responds (stops the clock) ────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/dispute/respond",
      summary: "Seller responds to a dispute (routes it to support)",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DisputeRespondSchema } } },
      },
      responses: {
        200: { description: "Response recorded", content: { "application/json": { schema: DisputeCaseSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "Not in a respondable state", content: { "application/json": { schema: ErrorSchema } } },
        422: { description: "A photo that isn't yours (bad_photo)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);
      const photos = ownedPaths(user.sub, b.photoPaths);
      if (!photos) return c.json({ error: "bad_photo" }, 422);

      const r = await transition(db, {
        dealId: id,
        actor: "SELLER",
        actorId: user.sub,
        action: "respond",
        reason: "seller responded",
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_respondable" : "conflict" }, 409);
      }
      const [row] = await db<CaseRow[]>`
        update public.dispute_cases
        set seller_response = ${b.response}, seller_evidence = ${b.evidence ?? null}, seller_photo_paths = ${photos},
            status = 'responded', responded_at = now()
        where deal_id = ${id} and status <> 'resolved'
        returning ${db.unsafe(SELECT)}
      `;
      return c.json(row ? await toCase(row) : stubCase(id, { status: "responded", sellerResponse: b.response }), 200);
    },
  );

  // ── POST /deals/{id}/dispute/resolve — CX/support admin adjudicates ─────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/dispute/resolve",
      summary: "Support admin resolves a dispute (release or refund)",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: DisputeResolveSchema } } },
      },
      responses: {
        200: { description: "Resolved", content: { "application/json": { schema: DisputeCaseSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Not staff", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        409: { description: "Not resolvable in this state", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const b = c.req.valid("json");

      // Conflict of interest: a staff member who is a party to the deal must not
      // adjudicate their own dispute (the whole product is "the neutral party").
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal) return c.json({ error: "not_found" }, 404);
      if (deal.buyer_id === user.sub || deal.seller_id === user.sub)
        return c.json({ error: "conflict_of_interest" }, 403);

      const r = await transition(db, {
        dealId: id,
        actor: "ADMIN",
        actorId: user.sub,
        action: b.resolution === "release" ? "resolve_release" : "resolve_refund",
        reason: b.note?.slice(0, 200) ?? `admin ${b.resolution}`,
        idempotencyKey: idem(c),
      });
      if (!r.ok) {
        if (r.code === "not_found") return c.json({ error: "not_found" }, 404);
        return c.json({ error: r.code === "illegal" ? "not_resolvable" : "conflict" }, 409);
      }
      const [row] = await db<CaseRow[]>`
        update public.dispute_cases
        set status = 'resolved', resolution = ${b.resolution}, resolved_by = ${user.sub},
            resolution_note = ${b.note ?? null}, resolved_at = now()
        where deal_id = ${id}
        returning ${db.unsafe(SELECT)}
      `;
      return c.json(
        row ? await toCase(row) : stubCase(id, { status: "resolved", resolution: b.resolution, resolvedBy: user.sub }),
        200,
      );
    },
  );

  // ── GET /deals/{id}/dispute — a dispute case (party or staff) ───────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}/dispute",
      summary: "Read a dispute case (party or staff)",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Dispute case", content: { "application/json": { schema: DisputeCaseSchema } } },
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
      const [deal] = await db<{ buyer_id: string; seller_id: string }[]>`
        select buyer_id, seller_id from public.deals where id = ${id}
      `;
      if (!deal) return c.json({ error: "not_found" }, 404);
      const party = deal.buyer_id === user.sub || deal.seller_id === user.sub;
      if (!party && !(await isStaffAdmin(db, user.sub))) return c.json({ error: "not_found" }, 404);
      const [row] = await db<CaseRow[]>`
        select ${db.unsafe(SELECT)} from public.dispute_cases where deal_id = ${id}
      `;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(await toCase(row), 200);
    },
  );

  // ── GET /admin/disputes — the support queue (staff only) ────────────────────
  // Driven by the AUTHORITATIVE deal state, left-joined to the (display-only) case —
  // so a dispute is never lost from the queue even if its case row write failed.
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/disputes",
      summary: "Open dispute queue (staff only)",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Open disputes", content: { "application/json": { schema: z.array(DisputeQueueItemSchema) } } },
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
      const rows = await db<
        {
          deal_id: string;
          deal_state: string;
          buyer_id: string;
          seller_id: string;
          status: "open" | "responded" | "resolved" | null;
          reason: string | null;
          opened_by: string | null;
          created_at: string | Date | null;
          responded_at: string | Date | null;
          buyer_disputes_30d: number;
          listing_title: string | null;
          principal: string | number;
        }[]
      >`
        select d.id as deal_id, d.state as deal_state, d.buyer_id, d.seller_id,
               l.title as listing_title, d.price_kobo as principal, -- price_kobo is the deal TOTAL (0008)
               c.status, c.reason, c.opened_by, c.created_at, c.responded_at,
               (select count(*) from public.deal_events e
                where e.action = 'dispute' and e.actor_id = d.buyer_id
                  and e.created_at > now() - interval '30 days')::int as buyer_disputes_30d
        from public.deals d
        left join public.dispute_cases c on c.deal_id = d.id
        left join public.listings l on l.id = d.listing_id
        where d.state in ('DISPUTED', 'DISPUTED_RESPONDED')
        order by coalesce(c.created_at, d.updated_at)
      `;
      const people = await userSummaries(db, rows.flatMap((r) => [r.buyer_id, r.seller_id]));
      return c.json(
        rows.map((r) => ({
          dealId: r.deal_id,
          dealState: r.deal_state,
          buyerId: r.buyer_id,
          sellerId: r.seller_id,
          status: r.status,
          reason: r.reason,
          openedBy: r.opened_by,
          createdAt: isoN(r.created_at),
          respondedAt: isoN(r.responded_at),
          buyerDisputes30d: r.buyer_disputes_30d,
          listingTitle: r.listing_title,
          principalKobo: Number(r.principal),
          buyer: people.get(r.buyer_id)!,
          seller: people.get(r.seller_id)!,
        })),
        200,
      );
    },
  );

  // ── GET /admin/disputes/{id} — the full picture for a decision (staff only) ──
  // Staff read the parties' chat here; the privacy policy covers it ("prevent fraud,
  // resolve disputes" — deals, messages, reports; legitimate interest).
  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/disputes/{id}",
      summary: "A disputed deal with its case, timeline and chat (staff only)",
      tags: ["disputes"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Dispute detail", content: { "application/json": { schema: DisputeDetailSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "Not staff", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const [d] = await db<
        {
          id: string;
          state: string;
          price_kobo: string | number;
          qty: number;
          created_at: string | Date;
          buyer_id: string;
          seller_id: string;
          listing_id: string;
          title: string | null;
          lane: string | null;
          status: string | null;
          image_path: string | null;
          buyer_disputes_30d: number;
        }[]
      >`
        select d.id, d.state, d.price_kobo, d.qty, d.created_at, d.buyer_id, d.seller_id, d.listing_id,
               l.title, l.lane, l.status, l.image_paths[1] as image_path,
               (select count(*) from public.deal_events e
                where e.action = 'dispute' and e.actor_id = d.buyer_id
                  and e.created_at > now() - interval '30 days')::int as buyer_disputes_30d
        from public.deals d left join public.listings l on l.id = d.listing_id
        where d.id = ${id}
      `;
      if (!d) return c.json({ error: "not_found" }, 404);
      const [caseRows, events, messages, people] = await Promise.all([
        db<CaseRow[]>`select ${db.unsafe(SELECT)} from public.dispute_cases where deal_id = ${id}`,
        db<
          {
            seq: number;
            actor: string;
            action: string;
            from_state: string | null;
            to_state: string;
            price_kobo: string | number | null;
            reason: string | null;
            created_at: string | Date;
          }[]
        >`
          select seq, actor, action, from_state, to_state, price_kobo, reason, created_at
          from public.deal_events where deal_id = ${id} order by seq
        `,
        db<{ id: string | number; sender_id: string; body: string; created_at: string | Date }[]>`
          select * from (
            select m.id, m.sender_id, m.body, m.created_at from public.messages m
            join public.conversations cv on cv.id = m.conversation_id
            where cv.listing_id = ${d.listing_id} and cv.buyer_id = ${d.buyer_id}
            order by m.created_at desc limit 200
          ) t order by created_at
        `,
        userSummaries(db, [d.buyer_id, d.seller_id]),
      ]);
      return c.json(
        {
          case: caseRows[0] ? await toCase(caseRows[0]) : null,
          deal: { id: d.id, state: d.state, priceKobo: Number(d.price_kobo), qty: d.qty, createdAt: iso(d.created_at) },
          listing: d.title
            ? {
                id: d.listing_id,
                title: d.title,
                lane: d.lane ?? "",
                status: d.status ?? "",
                imageUrl: d.image_path ? await createSignedDownloadUrl(LISTING_IMAGES_BUCKET, d.image_path) : null,
              }
            : null,
          buyer: people.get(d.buyer_id)!,
          seller: people.get(d.seller_id)!,
          buyerDisputes30d: d.buyer_disputes_30d,
          events: events.map((e) => ({
            seq: e.seq,
            actor: e.actor,
            action: e.action,
            fromState: e.from_state,
            toState: e.to_state,
            priceKobo: e.price_kobo == null ? null : Number(e.price_kobo),
            reason: e.reason,
            createdAt: iso(e.created_at),
          })),
          messages: messages.map((m) => ({ id: Number(m.id), senderId: m.sender_id, body: m.body, createdAt: iso(m.created_at) })),
        },
        200,
      );
    },
  );
}
