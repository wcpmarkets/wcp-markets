import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { railFor } from "../money/checkout.js";
import { createRecipient, listBanks, PaystackError, resolveAccount } from "../money/paystack.js";

/**
 * Where a seller's payouts go (20m-payout, Phase 3 H). The bank resolves the account
 * name (shown back for the seller to confirm); we then create a Paystack transfer
 * recipient and keep only its code + the last 4 digits. On the mock rail (test
 * accounts / no key) the bank list is a fixed sample and the recipient is a mock one.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const BankSchema = z.object({ code: z.string(), name: z.string() }).openapi("Bank");
const BanksSchema = z.object({ banks: z.array(BankSchema) }).openapi("Banks");
const PayoutAccountSchema = z
  .object({
    bankCode: z.string(),
    bankName: z.string(),
    accountLast4: z.string(),
    accountName: z.string(),
    updatedAt: z.string(),
  })
  .openapi("PayoutAccount");
const PayoutAccountResultSchema = z.object({ account: PayoutAccountSchema.nullable() }).openapi("PayoutAccountResult");
const ResolveRequestSchema = z
  .object({ bankCode: z.string().min(1).max(10), accountNumber: z.string().regex(/^\d{10}$/) })
  .openapi("ResolveAccountRequest");
const ResolveResultSchema = z.object({ accountName: z.string() }).openapi("ResolveAccountResult");
const SaveRequestSchema = ResolveRequestSchema.openapi("SavePayoutAccountRequest");

const MOCK_BANKS = [
  { code: "044", name: "Access Bank" },
  { code: "058", name: "GTBank" },
  { code: "057", name: "Zenith Bank" },
  { code: "033", name: "United Bank for Africa" },
  { code: "011", name: "First Bank of Nigeria" },
  { code: "50211", name: "Kuda Bank" },
  { code: "999992", name: "OPay" },
];

type Row = { bank_code: string; bank_name: string; account_last4: string; account_name: string; updated_at: Date };
const out = (r: Row) => ({
  bankCode: r.bank_code,
  bankName: r.bank_name,
  accountLast4: r.account_last4,
  accountName: r.account_name,
  updatedAt: r.updated_at.toISOString(),
});

async function banksFor(rail: "mock" | "paystack") {
  if (rail === "mock") return MOCK_BANKS;
  return (await listBanks()).map((b) => ({ code: b.code, name: b.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve on the rail: Paystack asks the bank; the mock names any 10 digits. */
async function resolveOn(rail: "mock" | "paystack", accountNumber: string, bankCode: string): Promise<string | null> {
  if (rail === "mock") return "TEST ACCOUNT HOLDER";
  try {
    return (await resolveAccount(accountNumber, bankCode)).account_name;
  } catch (e) {
    if (e instanceof PaystackError && e.status >= 400 && e.status < 500) return null; // no such account
    throw e;
  }
}

const resolveLimit = rateLimit({ prefix: "acct-resolve", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] });

export function registerPayoutAccounts(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/banks",
      summary: "Banks a payout can go to",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Banks", content: { "application/json": { schema: BanksSchema } } },
        401: { description: "Unauthorized" },
        502: { description: "Paystack unavailable", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      try {
        return c.json({ banks: await banksFor(await railFor(db, c.get("user").sub)) }, 200);
      } catch (e) {
        console.error("[banks]", e instanceof PaystackError ? `${e.status} ${e.message}` : e);
        return c.json({ error: "banks_unavailable" }, 502);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/me/payout-account",
      summary: "My payout account (null if not set)",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Account", content: { "application/json": { schema: PayoutAccountResultSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const [r] = await db<Row[]>`
        select bank_code, bank_name, account_last4, account_name, updated_at from public.payout_accounts where user_id = ${c.get("user").sub}`;
      return c.json({ account: r ? out(r) : null }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/me/payout-account/resolve",
      summary: "Look up the name on a bank account (to confirm before saving)",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, resolveLimit] as const,
      request: { body: { content: { "application/json": { schema: ResolveRequestSchema } } } },
      responses: {
        200: { description: "Resolved", content: { "application/json": { schema: ResolveResultSchema } } },
        401: { description: "Unauthorized" },
        422: { description: "account_not_found", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Too many lookups", content: { "application/json": { schema: ErrorSchema } } },
        502: { description: "Paystack unavailable", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { bankCode, accountNumber } = c.req.valid("json");
      try {
        const name = await resolveOn(await railFor(db, c.get("user").sub), accountNumber, bankCode);
        if (!name) return c.json({ error: "account_not_found" }, 422);
        return c.json({ accountName: name }, 200);
      } catch (e) {
        console.error("[resolve]", e instanceof PaystackError ? `${e.status} ${e.message}` : e);
        return c.json({ error: "resolve_unavailable" }, 502);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "put",
      path: "/me/payout-account",
      summary: "Save (or replace) my payout account",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth, resolveLimit] as const,
      request: { body: { content: { "application/json": { schema: SaveRequestSchema } } } },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: PayoutAccountResultSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "payout_pending — wait for the payout in flight", content: { "application/json": { schema: ErrorSchema } } },
        422: { description: "account_not_found / unknown_bank", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Too many lookups", content: { "application/json": { schema: ErrorSchema } } },
        502: { description: "Paystack unavailable", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { bankCode, accountNumber } = c.req.valid("json");
      // Don't swap the destination under a transfer that's already on its way.
      const [inflight] = await db`select 1 from public.payouts where seller_id = ${uid} and status = 'pending' limit 1`;
      if (inflight) return c.json({ error: "payout_pending" }, 409);
      const rail = await railFor(db, uid);
      try {
        const bank = (await banksFor(rail)).find((b) => b.code === bankCode);
        if (!bank) return c.json({ error: "unknown_bank" }, 422);
        const name = await resolveOn(rail, accountNumber, bankCode);
        if (!name) return c.json({ error: "account_not_found" }, 422);
        const recipient =
          rail === "mock"
            ? `mock_rcp_${uid.slice(0, 8)}_${accountNumber.slice(-4)}`
            : (await createRecipient({ name, accountNumber, bankCode, userId: uid })).recipient_code;
        const [r] = await db<Row[]>`
          insert into public.payout_accounts (user_id, bank_code, bank_name, account_last4, account_name, recipient_code, provider)
          values (${uid}, ${bankCode}, ${bank.name}, ${accountNumber.slice(-4)}, ${name}, ${recipient}, ${rail})
          on conflict (user_id) do update set bank_code = excluded.bank_code, bank_name = excluded.bank_name,
            account_last4 = excluded.account_last4, account_name = excluded.account_name,
            recipient_code = excluded.recipient_code, provider = excluded.provider, updated_at = now()
          returning bank_code, bank_name, account_last4, account_name, updated_at`;
        return c.json({ account: out(r!) }, 200);
      } catch (e) {
        console.error("[payout-account]", e instanceof PaystackError ? `${e.status} ${e.message}` : e);
        return c.json({ error: "payout_account_unavailable" }, 502);
      }
    },
  );
}
