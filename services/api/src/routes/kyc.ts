import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit, clientIp } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { getKycProvider } from "../kyc/provider.js";
import { createSignedUploadUrl, deleteStorageObject } from "../supabase.js";
import { hasPepper, idHash } from "../kyc/idhash.js";
import { payoutsPausedByRecovery } from "../recovery/service.js";
import { createWithdrawals } from "../money/withdrawals.js";
import { kickOutbox } from "../deals/sqs-relay.js";
import { getSmileId, SmileId } from "../kyc/smileid.js";
import { type Attempt, refreshAttempt, settleAttempt } from "../kyc/attempts.js";

// KYC verify is a match-oracle and (against real NIBSS) costs money per call — cap it
// per user, falling back to IP if somehow unauthenticated.
const kycRateLimit = rateLimit({
  prefix: "kyc:verify",
  limit: 5,
  windowSecs: 3600,
  keys: (c) => [(c.get("user") as { sub?: string } | undefined)?.sub ?? clientIp(c)],
});

/**
 * M8 — L2 KYC (Mock NIBSS) + payouts, payout-gated. A seller lists/sells freely; a
 * payout is refused until they're L2-verified. KYC stores the MATCH RESULT ONLY — the
 * BVN/NIN number is passed to the provider and never persisted (the table has no
 * column for it).
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const KycVerifySchema = z
  .object({
    idType: z.enum(["bvn", "nin"]),
    idNumber: z.string().min(4).max(32),
    selfiePath: z.string().max(300).optional(),
  })
  .openapi("KycVerify");
const KycStatusSchema = z
  .object({
    level: z.number().int(),
    matched: z.boolean().nullable(),
    idType: z.enum(["bvn", "nin"]).nullable(),
    /** A Smile ID check is still being decided. */
    pending: z.boolean(),
    /** How the latest Smile ID check ended, when it didn't verify: attention = under
     *  manual review, block = didn't match, error = couldn't be checked (try again). */
    lastOutcome: z.enum(["attention", "block", "error"]).nullable(),
  })
  .openapi("KycStatus");
const KycSessionReqSchema = z
  .object({
    idType: z.enum(["bvn", "nin"]),
    idNumber: z.string().regex(/^\d{11}$/),
    /** Legal names, as on the BVN/NIN record. */
    givenNames: z.string().trim().min(1).max(100),
    lastName: z.string().trim().min(1).max(100),
  })
  .openapi("KycSessionRequest");
const KycSessionSchema = z
  .object({
    /** "smileid": run the Smile ID SDK with this token. "mock": no provider configured —
     *  submit to POST /kyc/verify instead. */
    provider: z.enum(["smileid", "mock"]),
    attemptId: z.string().uuid().nullable(),
    token: z.string().nullable(),
    partnerId: z.string().nullable(),
    sandbox: z.boolean(),
    /** For the SDK: Smile ID's user id, country and id type for this check. */
    userId: z.string(),
    country: z.string(),
    smileIdType: z.string().nullable(),
  })
  .openapi("KycSession");
const KycSubmittedSchema = z.object({ jobId: z.string().regex(/^job_[0-9a-z]{20,40}$/) }).openapi("KycSubmitted");
const SelfieUploadReqSchema = z
  .object({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]) })
  .openapi("SelfieUploadRequest");
const SelfieUploadSchema = z.object({ path: z.string(), uploadUrl: z.string() }).openapi("SelfieUpload");

const PayoutSchema = z
  .object({
    id: z.string().uuid(),
    dealId: z.string().uuid(),
    sellerId: z.string().uuid(),
    amountKobo: z.number().int(),
    status: z.enum(["pending", "settled", "failed", "reversed"]),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
  })
  .openapi("Payout");

const IMG_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;
const iso = (v: string | Date): string => (typeof v === "string" ? v : v.toISOString());
const isoN = (v: string | Date | null): string | null => (v == null ? null : iso(v));
type PayoutRow = { id: string; deal_id: string; seller_id: string; amount_kobo: string | number; status: "pending" | "settled" | "failed"; created_at: string | Date; settled_at: string | Date | null };
const toPayout = (r: PayoutRow): z.infer<typeof PayoutSchema> => ({
  id: r.id, dealId: r.deal_id, sellerId: r.seller_id, amountKobo: Number(r.amount_kobo),
  status: r.status, createdAt: iso(r.created_at), settledAt: isoN(r.settled_at),
});
const idem = (c: { req: { header: (n: string) => string | undefined } }) => c.req.header("idempotency-key") ?? undefined;

type Db = NonNullable<Awaited<ReturnType<typeof getDb>>>;
const latestAttempt = async (db: Db, uid: string) =>
  (await db<(Attempt & { reason: string | null })[]>`
    select id, user_id, id_type, id_hash, job_id, status, reason, updated_at from public.kyc_attempts
    where user_id = ${uid} and job_id is not null order by created_at desc limit 1`)[0];

/** The caller's KYC status — settling a Smile ID check that's been processing a while. */
async function kycStatus(db: Db, uid: string): Promise<z.infer<typeof KycStatusSchema>> {
  let a = await latestAttempt(db, uid);
  // The webhook normally settles it; if it's slow (or not configured), ask Smile ID.
  if (a && a.status === "processing" && Date.now() - new Date(a.updated_at).getTime() > 15_000) {
    const smile = await getSmileId();
    if (smile) {
      await refreshAttempt(db, smile, a);
      a = await latestAttempt(db, uid);
    }
  }
  const [prof] = await db<{ verification_level: number }[]>`select verification_level from public.profiles where id = ${uid}`;
  const [kyc] = await db<{ matched: boolean; id_type: "bvn" | "nin" }[]>`select matched, id_type from public.kyc_verifications where user_id = ${uid}`;
  const level = prof?.verification_level ?? 1;
  return {
    level,
    matched: kyc?.matched ?? null,
    idType: kyc?.id_type ?? null,
    pending: a?.status === "processing",
    lastOutcome: level < 2 && a && ["attention", "block", "error"].includes(a.status) ? (a.status as "attention" | "block" | "error") : null,
  };
}

export function registerKyc(app: OpenAPIHono<AuthEnv>) {
  // ── POST /kyc/selfie-url — signed upload URL for the KYC selfie ──────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/kyc/selfie-url",
      summary: "Signed upload URL for a KYC selfie",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: SelfieUploadReqSchema } } } },
      responses: {
        200: { description: "Signed upload URL", content: { "application/json": { schema: SelfieUploadSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Storage unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { contentType } = c.req.valid("json");
      const path = `${user.sub}/${randomUUID()}.${IMG_EXT[contentType]}`;
      const signed = await createSignedUploadUrl("kyc-selfies", path);
      if (!signed) return c.json({ error: "storage_unavailable" }, 503);
      return c.json({ path, uploadUrl: signed.uploadUrl }, 200);
    },
  );

  // ── POST /kyc/verify — Mock NIBSS BVN/NIN match → L2 ────────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/kyc/verify",
      summary: "Verify identity (BVN/NIN) to reach L2",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, kycRateLimit] as const,
      request: { body: { content: { "application/json": { schema: KycVerifySchema } } } },
      responses: {
        200: { description: "Verification outcome", content: { "application/json": { schema: KycStatusSchema } } },
        400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "use_smileid — Smile ID is configured; start a check with POST /kyc/session", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      // With Smile ID configured the only way to L2 is its biometric check — this
      // mock match would otherwise be a bypass.
      if (await getSmileId()) return c.json({ error: "use_smileid" }, 409);
      const b = c.req.valid("json");
      // A selfie must belong to the caller (paths are `${uid}/…`).
      if (b.selfiePath && !b.selfiePath.startsWith(`${user.sub}/`))
        return c.json({ error: "invalid_selfie_path" }, 400);

      const [old] = await db<{ selfie_path: string | null; matched: boolean }[]>`
        select selfie_path, matched from public.kyc_verifications where user_id = ${user.sub}
      `;
      // The number goes to the provider IN MEMORY and is NEVER stored.
      const result = await getKycProvider().verifyIdentity({ idType: b.idType, idNumber: b.idNumber, selfiePath: b.selfiePath });
      // …and a keyed hash of it (never the number) so account recovery can re-match it.
      const hash = result.matched ? await idHash(b.idType, b.idNumber) : null;

      // Never DOWNGRADE: a failed re-verify by an already-verified user is a no-op.
      // (A matched re-verify by a verified user still writes — that's how a seller
      // verified before hashes were kept gets one: the payout 403 kyc_reverify path.)
      const wrote = result.matched || !old?.matched;
      if (wrote) {
        await db.begin(async (sql) => {
          await sql`
            insert into public.kyc_verifications (user_id, id_type, matched, level, selfie_path, provider_ref, id_hash, updated_at)
            values (${user.sub}, ${b.idType}, ${result.matched}, ${result.matched ? 2 : 1}, ${b.selfiePath ?? null}, ${result.providerRef}, ${hash}, now())
            on conflict (user_id) do update
              set id_type = excluded.id_type, matched = excluded.matched, level = excluded.level,
                  selfie_path = excluded.selfie_path, provider_ref = excluded.provider_ref,
                  id_hash = coalesce(excluded.id_hash, public.kyc_verifications.id_hash), updated_at = now()
          `;
          if (result.matched) {
            await sql`
              insert into public.profiles (id, verification_level) values (${user.sub}, 2)
              on conflict (id) do update set verification_level = 2, updated_at = now()
            `;
          }
        });
        // Clean up the replaced selfie (NDPA data-minimisation — don't leave orphans).
        if (old?.selfie_path && old.selfie_path !== (b.selfiePath ?? null))
          await deleteStorageObject("kyc-selfies", old.selfie_path);
      }

      const matched = result.matched || (old?.matched ?? false);
      return c.json({ level: matched ? 2 : 1, matched, idType: b.idType, pending: false, lastOutcome: null }, 200);
    },
  );

  // ── GET /kyc — the caller's KYC status ──────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/kyc",
      summary: "The caller's KYC status",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "KYC status", content: { "application/json": { schema: KycStatusSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      return c.json(await kycStatus(db, user.sub), 200);
    },
  );

  // ── POST /kyc/session — start a Smile ID Biometric KYC ──────────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/kyc/session",
      summary: "Start an identity check: a Smile ID token for the SDK (or 'mock')",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, kycRateLimit] as const,
      request: { body: { required: true, content: { "application/json": { schema: KycSessionReqSchema } } } },
      responses: {
        200: { description: "Session", content: { "application/json": { schema: KycSessionSchema } } },
        400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        429: { description: "Rate limited", content: { "application/json": { schema: ErrorSchema } } },
        502: { description: "smileid_unavailable", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const b = c.req.valid("json");
      const smile = await getSmileId();
      if (!smile)
        return c.json({ provider: "mock" as const, attemptId: null, token: null, partnerId: null, sandbox: true, userId: user.sub, country: "NG", smileIdType: null }, 200);
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      // Only the keyed hash is kept; the number goes to Smile ID inside the token request.
      const hash = await idHash(b.idType, b.idNumber);
      const [att] = await db<{ id: string }[]>`
        insert into public.kyc_attempts (user_id, id_type, id_hash, provider)
        values (${user.sub}, ${b.idType}, ${hash}, 'smileid') returning id`;
      let token: string;
      try {
        token = await smile.token({
          userId: user.sub,
          idType: b.idType,
          idNumber: b.idNumber,
          givenNames: b.givenNames,
          lastName: b.lastName,
          phone: user.phone ? `+${user.phone.replace(/\D/g, "")}` : null,
        });
      } catch (e) {
        console.error("[kyc] token:", (e as Error).message);
        await db`update public.kyc_attempts set status = 'abandoned', reason = 'token_failed', updated_at = now() where id = ${att!.id}`;
        return c.json({ error: "smileid_unavailable" }, 502);
      }
      return c.json(
        { provider: "smileid" as const, attemptId: att!.id, token, partnerId: smile.partnerId, sandbox: smile.sandbox, userId: user.sub, country: "NG", smileIdType: SmileId.idType(b.idType) },
        200,
      );
    },
  );

  // ── POST /kyc/attempts/{id}/submitted — the SDK handed the capture to Smile ID ─
  app.openapi(
    createRoute({
      method: "post",
      path: "/kyc/attempts/{id}/submitted",
      summary: "The app submitted a Smile ID check; returns the KYC status",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: {
        params: z.object({ id: z.string().uuid() }),
        body: { required: true, content: { "application/json": { schema: KycSubmittedSchema } } },
      },
      responses: {
        200: { description: "KYC status", content: { "application/json": { schema: KycStatusSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "Not found" },
        409: { description: "already_submitted (a different job)", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const { jobId } = c.req.valid("json");
      const [a] = await db<Attempt[]>`
        select id, user_id, id_type, id_hash, job_id, status, updated_at from public.kyc_attempts
        where id = ${id} and user_id = ${user.sub}`;
      if (!a) return c.json({ error: "not_found" }, 404);
      if (a.job_id && a.job_id !== jobId) return c.json({ error: "already_submitted" }, 409);
      if (!a.job_id) {
        const [bound] = await db<Attempt[]>`
          update public.kyc_attempts set job_id = ${jobId}, status = 'processing', updated_at = now()
          where id = ${id} and job_id is null and status = 'started'
          returning id, user_id, id_type, id_hash, job_id, status, updated_at`;
        if (!bound) return c.json({ error: "already_submitted" }, 409);
        const smile = await getSmileId();
        if (smile) await refreshAttempt(db, smile, bound);
      }
      return c.json(await kycStatus(db, user.sub), 200);
    },
  );

  // ── POST /webhooks/smileid — Smile ID says a job finished (raw; not in the client) ─
  // The signature covers only a timestamp, so the body is a nudge: we re-read the job's
  // status from Smile ID before settling anything. Always 2xx once authentic, so Smile
  // ID stops retrying; an unknown job is ignored (the app's submit/poll settles it).
  app.post("/webhooks/smileid", async (c) => {
    const smile = await getSmileId();
    if (!smile) return c.json({ error: "smileid_unconfigured" }, 503);
    if (!smile.verifyWebhook(c.req.header("response-signature"), c.req.header("response-timestamp")))
      return c.json({ error: "bad_signature" }, 401);
    const body = (await c.req.json().catch(() => ({}))) as { job_id?: string; reason?: string | null; partner_params?: { job_id?: string } | null };
    const jobId = body.partner_params?.job_id ?? body.job_id;
    const db = await getDb();
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    if (jobId) {
      const [a] = await db<Attempt[]>`
        select id, user_id, id_type, id_hash, job_id, status, updated_at from public.kyc_attempts where job_id = ${jobId}`;
      // The reason is informational only (shown nowhere that grants anything).
      if (a) await refreshAttempt(db, smile, a, typeof body.reason === "string" ? body.reason.slice(0, 64) : null);
    }
    return c.json({ ok: true }, 200);
  });

  // ── POST /deals/{id}/payout — seller withdraws a completed deal (L2-gated) ───
  app.openapi(
    createRoute({
      method: "post",
      path: "/deals/{id}/payout",
      summary: "Seller requests payout of a completed deal (requires L2)",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        201: { description: "Payout requested", content: { "application/json": { schema: PayoutSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "kyc_required (L2) / kyc_reverify (verify again once, for account recovery)", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        409: { description: "Not payable / already requested / recovery_hold (account recovery in progress) / no_payout_account", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<{ seller_id: string }[]>`select seller_id from public.deals where id = ${id}`;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);
      // Withdrawing one sale is a one-line withdrawal (money/withdrawals.ts): same gates,
      // same locks and balance checks, one transfer, and the seller pays its fee. Kept
      // for app builds from before POST /me/withdrawals and for the money test suites.
      const r = await createWithdrawals(db, { sellerId: user.sub, dealIds: [id], idempotencyKey: idem(c) ?? `deal:${id}:${randomUUID()}` });
      if (!r.ok) {
        if (r.status === 403) return c.json({ error: r.error }, 403);
        // The old route's names: a sale that isn't withdrawable is not_payable; one on
        // its way (or any withdrawal in flight) is already_requested.
        const error = r.error === "withdrawal_pending" ? "already_requested" : r.error === "nothing_to_withdraw" ? "not_payable" : r.error;
        return c.json({ error }, 409);
      }
      await kickOutbox(db);
      const [out] = await db<PayoutRow[]>`
        select id, deal_id, seller_id, amount_kobo, status, created_at, settled_at from public.payouts
        where deal_id = ${id} and withdrawal_id = any(${r.withdrawals.map((w) => w.id)}::uuid[])`;
      if (!out) return c.json({ error: "already_requested" }, 409);
      return c.json(toPayout(out), 201);
    },
  );

  // ── GET /deals/{id}/payout — the payout for a deal ──────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/deals/{id}/payout",
      summary: "The payout for a deal (seller only)",
      tags: ["kyc"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { params: z.object({ id: z.string().uuid() }) },
      responses: {
        200: { description: "Payout", content: { "application/json": { schema: PayoutSchema } } },
        401: { description: "Unauthorized" },
        404: { description: "No payout" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [row] = await db<PayoutRow[]>`
        select id, deal_id, seller_id, amount_kobo, status, created_at, settled_at
        from public.payouts where deal_id = ${id} and seller_id = ${user.sub}
        order by part desc limit 1
      `;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(toPayout(row), 200);
    },
  );
}
