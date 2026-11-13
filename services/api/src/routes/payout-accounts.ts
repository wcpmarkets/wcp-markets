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

// ── Earnings & payout history (Account → Payouts) ──────────────────────────────
const PayoutHistoryItemSchema = z
  .object({
    id: z.string().uuid(),
    dealId: z.string().uuid(),
    title: z.string(),
    amountKobo: z.number().int(),
    status: z.enum(["pending", "settled", "failed"]),
    /** 0 for a whole deal; 0, 1, … for a staged job withdrawn in parts. */
    part: z.number().int(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
  })
  .openapi("PayoutHistoryItem");
const PayoutReadySchema = z
  .object({ dealId: z.string().uuid(), title: z.string(), amountKobo: z.number().int(), releasedAt: z.string() })
  .openapi("PayoutReady");
const EarningsSchema = z
  .object({
    /** Released to the seller, not yet withdrawn or on its way. */
    availableKobo: z.number().int(),
    /** Payouts on their way to the bank. */
    processingKobo: z.number().int(),
    /** Held in escrow for open deals, before the seller fee. */
    inEscrowKobo: z.number().int(),
    /** Ever paid out to the bank. */
    paidOutKobo: z.number().int(),
    ready: z.array(PayoutReadySchema),
    payouts: z.array(PayoutHistoryItemSchema),
  })
  .openapi("Earnings");

const iso = (d: Date | string) => (d instanceof Date ? d : new Date(d)).toISOString();

const resolveLimit = rateLimit({ prefix: "acct-resolve", limit: 20, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] });

export function registerPayoutAccounts(app: OpenAPIHono<AuthEnv>) {
  // What the seller has earned and where it is. All of it is derived: released money
  // is the deal's seller_payable balance in the ledger (a settled payout books it back
  // out), a pending payout isn't in the ledger yet so it's subtracted here, and escrow
  // is what the ledger still holds for the seller's open deals.
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/payouts",
      summary: "The seller's earnings: balances, deals ready to withdraw, payout history",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Earnings", content: { "application/json": { schema: EarningsSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const [deals, payouts] = await Promise.all([
        db<{ deal_id: string; title: string | null; payable: string; held: string; pending: string; released_at: Date | null }[]>`
          with mine as (select id, listing_id from public.deals where seller_id = ${uid}),
          led as (
            select le.deal_id,
                   sum(le.amount_kobo) filter (where le.account = 'seller_payable') as payable,
                   sum(le.amount_kobo) filter (where le.account = 'escrow_holding') as held,
                   max(le.created_at) filter (where le.account = 'seller_payable' and le.movement = 'release') as released_at
            from public.ledger_entries le join mine m on m.id = le.deal_id
            group by le.deal_id
          )
          select led.deal_id, l.title,
                 coalesce(led.payable, 0)::bigint as payable,
                 -- A shortlet's caution deposit (stage 2) is the guest's money, not the host's.
                 (coalesce(led.held, 0) - coalesce((
                    select sum(ms.amount_kobo) from public.deal_milestones ms
                    join public.bookings b on b.deal_id = ms.deal_id
                    where ms.deal_id = led.deal_id and ms.idx = 2 and ms.status in ('held', 'refunding')), 0))::bigint as held,
                 coalesce((select sum(p.amount_kobo) from public.payouts p
                           where p.deal_id = led.deal_id and p.status = 'pending'), 0)::bigint as pending,
                 led.released_at
          from led join mine m on m.id = led.deal_id
          left join public.listings l on l.id = m.listing_id
          where coalesce(led.payable, 0) <> 0 or coalesce(led.held, 0) <> 0
        `,
        db<{ id: string; deal_id: string; title: string | null; amount_kobo: string; status: "pending" | "settled" | "failed"; part: number; created_at: Date; settled_at: Date | null }[]>`
          select p.id, p.deal_id, l.title, p.amount_kobo, p.status, p.part, p.created_at, p.settled_at
          from public.payouts p
          join public.deals d on d.id = p.deal_id
          left join public.listings l on l.id = d.listing_id
          where p.seller_id = ${uid}
          order by p.created_at desc
          limit 100
        `,
      ]);

      const title = (t: string | null) => t ?? "Listing removed";
      let availableKobo = 0;
      let processingKobo = 0;
      let inEscrowKobo = 0;
      const ready: z.infer<typeof PayoutReadySchema>[] = [];
      for (const d of deals) {
        const payable = Number(d.payable);
        const pending = Number(d.pending);
        processingKobo += pending;
        inEscrowKobo += Math.max(0, Number(d.held));
        const free = payable - pending;
        // A pending payout is withdrawn already; only a deal with none in flight can be
        // withdrawn again (one payout in flight per deal — routes/kyc.ts).
        if (free > 0 && pending === 0) {
          availableKobo += free;
          ready.push({ dealId: d.deal_id, title: title(d.title), amountKobo: free, releasedAt: iso(d.released_at ?? new Date()) });
        }
      }
      ready.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
      const paidOutKobo = payouts.filter((p) => p.status === "settled").reduce((a, p) => a + Number(p.amount_kobo), 0);
      return c.json(
        {
          availableKobo,
          processingKobo,
          inEscrowKobo,
          paidOutKobo,
          ready,
          payouts: payouts.map((p) => ({
            id: p.id,
            dealId: p.deal_id,
            title: title(p.title),
            amountKobo: Number(p.amount_kobo),
            status: p.status,
            part: p.part,
            createdAt: iso(p.created_at),
            settledAt: p.settled_at ? iso(p.settled_at) : null,
          })),
        },
        200,
      );
    },
  );

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
