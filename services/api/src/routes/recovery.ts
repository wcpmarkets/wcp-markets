import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit, clientIp } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { isStaffAdmin } from "../deals/admin.js";
import { normalizeNgPhone, maskName, maskPhone } from "../recovery/phone.js";
import {
  answerRecovery,
  approveRecovery,
  cancelRecovery,
  getRecovery,
  ownerRecovery,
  requesterRecovery,
  startRecovery,
  toOwnerView,
  toRequesterView,
  type RecoveryRow,
} from "../recovery/service.js";

/**
 * Account recovery (20j-recover-1…4) — see src/recovery/service.ts for the flow.
 * Every route needs a signed-in caller: the requester signs in with the NEW number
 * first, so the lookup is never anonymous.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const QuestionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["choice", "text"]),
    prompt: z.string(),
    options: z.array(z.object({ id: z.string(), label: z.string() }).openapi("RecoveryOption")).nullable(),
    hint: z.string().nullable(),
  })
  .openapi("RecoveryQuestion");

const RecoveryStatus = z.enum(["identity", "review", "holding", "completed", "cancelled", "failed"]);
const RecoverySchema = z
  .object({
    id: z.string().uuid(),
    status: RecoveryStatus,
    branch: z.enum(["seller", "basic"]),
    accountName: z.string().nullable(),
    lostPhone: z.string(),
    newPhone: z.string(),
    questions: z.array(QuestionSchema),
    attemptsLeft: z.number().int(),
    holdUntil: z.string().nullable(),
    closedReason: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("Recovery");

const AnswerResultSchema = z
  .object({ correct: z.boolean(), recovery: RecoverySchema })
  .openapi("RecoveryAnswerResult");

const OwnerRecoverySchema = z
  .object({
    id: z.string().uuid(),
    status: RecoveryStatus,
    newPhone: z.string(),
    holdUntil: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("OwnerRecovery");
const OwnerRecoveryResultSchema = z.object({ recovery: OwnerRecoverySchema.nullable() }).openapi("OwnerRecoveryResult");

const AdminRecoverySchema = z
  .object({
    id: z.string().uuid(),
    status: RecoveryStatus,
    branch: z.enum(["seller", "basic"]),
    accountId: z.string().uuid(),
    accountName: z.string().nullable(),
    lostPhone: z.string(),
    newPhone: z.string(),
    attempts: z.number().int(),
    holdUntil: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi("AdminRecovery");

const StartSchema = z.object({ lostPhone: z.string().min(7).max(20) }).openapi("RecoveryStart");
const AnswerSchema = z
  .object({
    idType: z.enum(["bvn", "nin"]).optional(),
    idNumber: z.string().min(4).max(32).optional(),
    answers: z.array(z.object({ questionId: z.string().max(40), value: z.string().min(1).max(200) }).openapi("RecoveryAnswer")).max(10).optional(),
  })
  .openapi("RecoveryAnswerRequest");

const userKey = (c: { get: (k: "user") => { sub: string } | undefined }) => c.get("user")?.sub ?? "anon";
// The lookup tells you whether a number has an account — cap it hard per caller.
// The IP cap is looser: Nigerian mobile carriers put many people behind one address.
const startLimit = [
  rateLimit({ prefix: "recovery:start:u", limit: 5, windowSecs: 3600, keys: (c) => [userKey(c as never)] }),
  rateLimit({ prefix: "recovery:start:ip", limit: 30, windowSecs: 3600, keys: (c) => [clientIp(c)] }),
] as const;
// Every ID check is a provider call and a guess — cap it beyond the 3-attempt rule.
const answerLimit = [
  rateLimit({ prefix: "recovery:answer:u", limit: 10, windowSecs: 3600, keys: (c) => [userKey(c as never)] }),
  rateLimit({ prefix: "recovery:answer:ip", limit: 60, windowSecs: 3600, keys: (c) => [clientIp(c)] }),
] as const;

const json = <T extends z.ZodTypeAny>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const err = (description: string) => json(ErrorSchema, description);

async function nameOf(db: NonNullable<Awaited<ReturnType<typeof getDb>>>, id: string) {
  const [p] = await db<{ display_name: string | null }[]>`select display_name from public.profiles where id = ${id}`;
  return p?.display_name ?? null;
}

export function registerRecovery(app: OpenAPIHono<AuthEnv>) {
  // ── POST /recovery — look up the lost number, start (or resume) a request ────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recovery",
      summary: "Start recovering an account whose number was lost (signed in with the new number)",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, ...startLimit] as const,
      request: { body: { content: { "application/json": { schema: StartSchema } } } },
      responses: {
        201: json(RecoverySchema, "Recovery started (or resumed)"),
        400: err("Not a Nigerian mobile number"),
        401: { description: "Unauthorized" },
        404: err("No account on that number"),
        409: err("same_number / not_fresh / no_phone / in_progress"),
        429: err("Rate limited"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const lost = normalizeNgPhone(c.req.valid("json").lostPhone);
      if (!lost) return c.json({ error: "invalid_phone" }, 400);
      const r = await startRecovery(db, user.sub, lost);
      if (!r.ok) return c.json({ error: r.error }, r.error === "not_found" ? 404 : 409);
      return c.json(toRequesterView(r.row, r.displayName), 201);
    },
  );

  // ── GET /recovery — the caller's own request (open, else latest) ────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/recovery",
      summary: "The caller's recovery request",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: json(RecoverySchema, "Recovery"),
        401: { description: "Unauthorized" },
        404: err("No request"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const row = await requesterRecovery(db, user.sub);
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(toRequesterView(row, await nameOf(db, row.account_id)), 200);
    },
  );

  // ── POST /recovery/{id}/answer — the ID re-match or the account questions ────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recovery/{id}/answer",
      summary: "Prove the account is yours (seller: BVN/NIN; others: account questions)",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, ...answerLimit] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { content: { "application/json": { schema: AnswerSchema } } },
      },
      responses: {
        200: json(AnswerResultSchema, "Checked: holding / review on a pass, an attempt used otherwise"),
        400: err("missing_answer"),
        401: { description: "Unauthorized" },
        404: err("Not found"),
        409: err("Not awaiting an answer"),
        429: err("Rate limited"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const r = await answerRecovery(db, user.sub, id, c.req.valid("json"));
      if (!r.ok) return c.json({ error: r.error }, r.error === "not_found" ? 404 : r.error === "missing_answer" ? 400 : 409);
      return c.json({ correct: r.correct, recovery: toRequesterView(r.row, await nameOf(db, r.row.account_id)) }, 200);
    },
  );

  // ── POST /recovery/{id}/cancel — the requester withdraws ────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/recovery/{id}/cancel",
      summary: "Cancel your own recovery request",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: json(RecoverySchema, "Cancelled"),
        401: { description: "Unauthorized" },
        404: err("Not found"),
        409: err("Already closed"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const pre = await getRecovery(db, id);
      if (!pre || pre.requester_id !== user.sub) return c.json({ error: "not_found" }, 404);
      const row = await cancelRecovery(db, id, "requester");
      if (!row) return c.json({ error: "closed" }, 409);
      return c.json(toRequesterView(row, await nameOf(db, row.account_id)), 200);
    },
  );

  // ── GET /me/recovery — is someone moving MY account? (the owner's banner) ────
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/recovery",
      summary: "An open recovery against the caller's account, if any",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: json(OwnerRecoveryResultSchema, "The open recovery, or null"),
        401: { description: "Unauthorized" },
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const row = await ownerRecovery(db, user.sub);
      return c.json({ recovery: row ? toOwnerView(row) : null }, 200);
    },
  );

  // ── POST /me/recovery/cancel — the owner stops it ───────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/me/recovery/cancel",
      summary: "Stop a recovery of your account (it wasn't you)",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: json(OwnerRecoveryResultSchema, "Cancelled (recovery: the closed request)"),
        401: { description: "Unauthorized" },
        404: err("Nothing to cancel"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      // Any open request, including one still at the question step.
      const [open] = await db<{ id: string }[]>`
        select id from public.account_recoveries where account_id = ${user.sub} and status in ('identity', 'review', 'holding')`;
      if (!open) return c.json({ error: "not_found" }, 404);
      const row = await cancelRecovery(db, open.id, "owner");
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json({ recovery: toOwnerView(row) }, 200);
    },
  );

  // ── Admin: review queue + decisions ─────────────────────────────────────────
  const toAdmin = (r: RecoveryRow, name: string | null): z.infer<typeof AdminRecoverySchema> => ({
    id: r.id, status: r.status, branch: r.branch, accountId: r.account_id, accountName: maskName(name),
    lostPhone: maskPhone(r.lost_phone), newPhone: maskPhone(r.new_phone), attempts: r.attempts,
    holdUntil: r.hold_until?.toISOString() ?? null, createdAt: r.created_at.toISOString(),
  });

  app.openapi(
    createRoute({
      method: "get",
      path: "/admin/recoveries",
      summary: "Recoveries awaiting a decision (admin)",
      tags: ["recovery"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { query: z.object({ status: RecoveryStatus.optional() }) },
      responses: {
        200: json(z.array(AdminRecoverySchema), "Recoveries"),
        401: { description: "Unauthorized" },
        403: err("Forbidden"),
        503: err("Database unavailable"),
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
      const status = c.req.valid("query").status ?? "review";
      const rows = await db<(RecoveryRow & { display_name: string | null })[]>`
        select r.*, p.display_name from public.account_recoveries r
        left join public.profiles p on p.id = r.account_id
        where r.status = ${status} order by r.created_at limit 100`;
      return c.json(rows.map((r) => toAdmin(r, r.display_name)), 200);
    },
  );

  for (const action of ["approve", "reject"] as const) {
    app.openapi(
      createRoute({
        method: "post",
        path: `/admin/recoveries/{id}/${action}`,
        summary: action === "approve" ? "Approve a reviewed recovery → 24h hold (admin)" : "Reject a recovery (admin)",
        tags: ["recovery"],
        security: [{ bearerAuth: [] }],
        middleware: [auth] as const,
        request: { params: z.object({ id: z.string().uuid() }) },
        responses: {
          200: json(AdminRecoverySchema, action === "approve" ? "Now holding" : "Rejected"),
          401: { description: "Unauthorized" },
          403: err("Forbidden"),
          409: err("Not in a state for this"),
          503: err("Database unavailable"),
        },
      }),
      async (c) => {
        const user = c.get("user");
        const db = await getDb();
        if (!db) return c.json({ error: "db_unavailable" }, 503);
        if (!(await isStaffAdmin(db, user.sub))) return c.json({ error: "forbidden" }, 403);
        const { id } = c.req.valid("param");
        const row = action === "approve" ? await approveRecovery(db, id) : await cancelRecovery(db, id, "admin");
        if (!row) return c.json({ error: "wrong_state" }, 409);
        return c.json(toAdmin(row, await nameOf(db, row.account_id)), 200);
      },
    );
  }
}
