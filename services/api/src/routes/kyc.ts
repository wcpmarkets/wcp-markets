import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { getDb } from "../db.js";
import { getKycProvider } from "../kyc/provider.js";
import { createSignedUploadUrl } from "../supabase.js";

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
  })
  .openapi("KycStatus");
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
    status: z.enum(["pending", "settled", "failed"]),
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
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: KycVerifySchema } } } },
      responses: {
        200: { description: "Verification outcome", content: { "application/json": { schema: KycStatusSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");

      // The number goes to the provider IN MEMORY and is NEVER stored.
      const result = await getKycProvider().verifyIdentity({ idType: b.idType, idNumber: b.idNumber, selfiePath: b.selfiePath });
      const level = result.matched ? 2 : 1;

      await db.begin(async (sql) => {
        await sql`
          insert into public.kyc_verifications (user_id, id_type, matched, level, selfie_path, provider_ref, updated_at)
          values (${user.sub}, ${b.idType}, ${result.matched}, ${level}, ${b.selfiePath ?? null}, ${result.providerRef}, now())
          on conflict (user_id) do update
            set id_type = excluded.id_type, matched = excluded.matched, level = excluded.level,
                selfie_path = excluded.selfie_path, provider_ref = excluded.provider_ref, updated_at = now()
        `;
        if (result.matched) {
          await sql`
            insert into public.profiles (id, verification_level) values (${user.sub}, 2)
            on conflict (id) do update set verification_level = 2, updated_at = now()
          `;
        }
      });
      return c.json({ level, matched: result.matched, idType: b.idType }, 200);
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
      const [prof] = await db<{ verification_level: number }[]>`select verification_level from public.profiles where id = ${user.sub}`;
      const [kyc] = await db<{ matched: boolean; id_type: "bvn" | "nin" }[]>`select matched, id_type from public.kyc_verifications where user_id = ${user.sub}`;
      return c.json({ level: prof?.verification_level ?? 1, matched: kyc?.matched ?? null, idType: kyc?.id_type ?? null }, 200);
    },
  );

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
        403: { description: "KYC (L2) required", content: { "application/json": { schema: ErrorSchema } } },
        404: { description: "Not found" },
        409: { description: "Not payable / already requested", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { id } = c.req.valid("param");
      const [deal] = await db<{ seller_id: string; state: string }[]>`select seller_id, state from public.deals where id = ${id}`;
      if (!deal || deal.seller_id !== user.sub) return c.json({ error: "not_found" }, 404);
      if (deal.state !== "COMPLETED") return c.json({ error: "not_payable" }, 409);

      // The gate: no payout until the seller is L2-verified.
      const [prof] = await db<{ verification_level: number }[]>`select verification_level from public.profiles where id = ${user.sub}`;
      if ((prof?.verification_level ?? 1) < 2) return c.json({ error: "kyc_required" }, 403);

      const [bal] = await db<{ s: string }[]>`
        select coalesce(sum(amount_kobo), 0)::bigint as s from public.ledger_entries
        where deal_id = ${id} and account = 'seller_payable'
      `;
      const amount = Number(bal!.s);
      if (amount <= 0) return c.json({ error: "nothing_to_pay_out" }, 409);

      const out = await db.begin(async (sql) => {
        const [existing] = await sql<{ id: string }[]>`select id from public.payouts where deal_id = ${id}`;
        if (existing) return null;
        const [po] = await sql<PayoutRow[]>`
          insert into public.payouts (deal_id, seller_id, amount_kobo)
          values (${id}, ${user.sub}, ${amount})
          returning id, deal_id, seller_id, amount_kobo, status, created_at, settled_at
        `;
        await sql`
          insert into public.outbox (topic, payload, deal_id)
          values ('escrow.payout', ${sql.json({ dealId: id, amount, sellerId: user.sub })}, ${id})
        `;
        return po!;
      });
      if (!out) return c.json({ error: "already_requested" }, 409);
      void idem(c);
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
      `;
      if (!row) return c.json({ error: "not_found" }, 404);
      return c.json(toPayout(row), 200);
    },
  );
}
