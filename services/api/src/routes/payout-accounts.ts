import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { getDb } from "../db.js";
import { railFor } from "../money/checkout.js";
import { createRecipient, listBanks, PaystackError, resolveAccount } from "../money/paystack.js";
import { createWithdrawals, quote, readyDeals, type WithdrawalRow } from "../money/withdrawals.js";
import { MIN_WITHDRAWAL_KOBO, transferFeeKobo } from "../money/fees.js";
import type { Sql } from "../deals/commands.js";
import { kickOutbox } from "../deals/sqs-relay.js";

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
    // Only Paystack's "could not resolve" answers mean there's no such account. A 429
    // (rate limit — test mode allows 3 real-bank lookups a day), 401 or outage is "couldn't
    // check", which the routes report as 502, never as the seller mistyping the number.
    if (e instanceof PaystackError && [400, 404, 422].includes(e.status)) return null;
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
    status: z.enum(["pending", "settled", "failed", "reversed"]),
    /** 0 for a whole deal; 0, 1, … for a staged job withdrawn in parts. */
    part: z.number().int(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
  })
  .openapi("PayoutHistoryItem");
const PayoutReadySchema = z
  .object({
    dealId: z.string().uuid(),
    title: z.string(),
    amountKobo: z.number().int(),
    releasedAt: z.string(),
    /** The transfer fee if this sale is withdrawn on its own (the seller pays it). */
    feeKobo: z.number().int(),
    /** False when withdrawing just this sale is under the minimum and doesn't empty the balance. */
    canWithdrawAlone: z.boolean(),
  })
  .openapi("PayoutReady");

// ── Withdrawals (0043): one transfer, one fee, one or more whole sales ─────────
const WithdrawalQuoteSchema = z
  .object({
    /** Leaves the seller's balance. */
    grossKobo: z.number().int(),
    /** The bank-transfer fee, taken from what's sent. */
    feeKobo: z.number().int(),
    /** Reaches the bank. */
    netKobo: z.number().int(),
    allowed: z.boolean(),
    reason: z.enum(["nothing_to_withdraw", "below_minimum"]).nullable(),
  })
  .openapi("WithdrawalQuote");
const WithdrawalLineSchema = z
  .object({ dealId: z.string().uuid(), title: z.string(), amountKobo: z.number().int() })
  .openapi("WithdrawalLine");
const WithdrawalSchema = z
  .object({
    id: z.string().uuid(),
    amountKobo: z.number().int(),
    feeKobo: z.number().int(),
    netKobo: z.number().int(),
    status: z.enum(["pending", "settled", "failed", "reversed"]),
    bankName: z.string().nullable(),
    accountLast4: z.string().nullable(),
    createdAt: z.string(),
    settledAt: z.string().nullable(),
    lines: z.array(WithdrawalLineSchema),
  })
  .openapi("Withdrawal");
const WithdrawalsResultSchema = z.object({ withdrawals: z.array(WithdrawalSchema) }).openapi("WithdrawalsResult");
const WithdrawRequestSchema = z
  .object({
    /** The sales to withdraw; omit for everything available. Whole sales only. */
    dealIds: z.array(z.string().uuid()).min(1).max(100).optional(),
    /** The same key again (a retried tap) returns the withdrawal it already made. */
    idempotencyKey: z.string().min(8).max(100),
  })
  .openapi("WithdrawRequest");

/** Withdrawals with their lines, newest first. */
async function withdrawalsOf(db: Sql, rows: WithdrawalRow[]): Promise<z.infer<typeof WithdrawalSchema>[]> {
  if (!rows.length) return [];
  const lines = await db<{ withdrawal_id: string; deal_id: string; title: string | null; amount_kobo: string }[]>`
    select p.withdrawal_id, p.deal_id, l.title, p.amount_kobo
    from public.payouts p join public.deals d on d.id = p.deal_id
    left join public.listings l on l.id = d.listing_id
    where p.withdrawal_id = any(${rows.map((r) => r.id)}::uuid[])
    order by p.created_at`;
  return rows.map((w) => ({
    id: w.id,
    amountKobo: Number(w.amount_kobo),
    feeKobo: Number(w.fee_kobo),
    netKobo: Number(w.net_kobo),
    status: w.status as "pending" | "settled" | "failed" | "reversed",
    bankName: w.bank_name,
    accountLast4: w.account_last4,
    createdAt: iso(w.created_at),
    settledAt: w.settled_at ? iso(w.settled_at) : null,
    lines: lines.filter((l) => l.withdrawal_id === w.id)
      .map((l) => ({ dealId: l.deal_id, title: l.title ?? "Listing removed", amountKobo: Number(l.amount_kobo) })),
  }));
}
const EarningsSchema = z
  .object({
    /** Released to the seller, not yet withdrawn or on its way. */
    availableKobo: z.number().int(),
    /** Payouts on their way to the bank. */
    processingKobo: z.number().int(),
    /** Held in escrow for open deals, before the seller fee. */
    inEscrowKobo: z.number().int(),
    /** Ever reached the seller's bank: settled withdrawals, after transfer fees. */
    paidOutKobo: z.number().int(),
    ready: z.array(PayoutReadySchema),
    /** Per-sale payout lines (kept for older app builds; new ones read withdrawals). */
    payouts: z.array(PayoutHistoryItemSchema),
    /** Withdrawing everything available now, in one go. */
    withdrawAll: WithdrawalQuoteSchema,
    /** ₦1,000 — waived when a withdrawal empties the balance. */
    minWithdrawalKobo: z.number().int(),
    /** Withdrawals, newest first, each with the sales it paid out. */
    withdrawals: z.array(WithdrawalSchema),
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
      let processingKobo = 0;
      let inEscrowKobo = 0;
      for (const d of deals) {
        processingKobo += Number(d.pending);
        inEscrowKobo += Math.max(0, Number(d.held));
      }
      // What can be withdrawn is the withdrawal code's own answer (money/withdrawals.ts),
      // so the screen and POST /me/withdrawals can't disagree.
      const readyNow = await readyDeals(db, uid);
      const availableKobo = readyNow.reduce((a, d) => a + d.amountKobo, 0);
      const ready = readyNow
        .map((d) => {
          const q = quote([d], availableKobo);
          return { dealId: d.dealId, title: d.title, amountKobo: d.amountKobo, releasedAt: iso(d.releasedAt), feeKobo: transferFeeKobo(d.amountKobo), canWithdrawAlone: q.allowed };
        })
        .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
      const all = quote(readyNow, availableKobo);
      const wrows = await db<WithdrawalRow[]>`
        select id, seller_id, amount_kobo, fee_kobo, net_kobo, status, rail, bank_name, account_last4, created_at, settled_at
        from public.withdrawals where seller_id = ${uid} order by created_at desc limit 50`;
      // What actually reached the bank (net of the transfer fee), over all time — not
      // just the history rows above, which are capped.
      const [paid] = await db<{ s: string }[]>`
        select coalesce(sum(net_kobo), 0)::bigint as s from public.withdrawals where seller_id = ${uid} and status = 'settled'`;
      const paidOutKobo = Number(paid!.s);
      return c.json(
        {
          availableKobo,
          processingKobo,
          inEscrowKobo,
          paidOutKobo,
          ready,
          withdrawAll: { grossKobo: all.grossKobo, feeKobo: all.feeKobo, netKobo: all.netKobo, allowed: all.allowed, reason: all.reason },
          minWithdrawalKobo: MIN_WITHDRAWAL_KOBO,
          withdrawals: await withdrawalsOf(db, wrows),
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

  // ── POST /me/withdrawals — withdraw everything, or the sales picked ──────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/me/withdrawals",
      summary: "Withdraw released money: everything available, or chosen whole sales (one transfer, one fee)",
      tags: ["payouts"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: WithdrawRequestSchema } } } },
      responses: {
        200: { description: "Replay: the withdrawal this key already made", content: { "application/json": { schema: WithdrawalsResultSchema } } },
        201: { description: "Withdrawal made and on its way", content: { "application/json": { schema: WithdrawalsResultSchema } } },
        401: { description: "Unauthorized" },
        403: { description: "kyc_required (L2) / kyc_reverify", content: { "application/json": { schema: ErrorSchema } } },
        409: {
          description: "nothing_to_withdraw / below_minimum / not_payable / already_requested / withdrawal_pending / no_payout_account / recovery_hold / balance_changed",
          content: { "application/json": { schema: ErrorSchema } },
        },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = c.req.valid("json");
      const r = await createWithdrawals(db, { sellerId: uid, dealIds: b.dealIds, idempotencyKey: b.idempotencyKey });
      if (!r.ok) return r.status === 403 ? c.json({ error: r.error }, 403) : c.json({ error: r.error }, 409);
      // Send it now rather than on the sweeper's next minute (best effort).
      if (!r.replay) await kickOutbox(db);
      return c.json({ withdrawals: await withdrawalsOf(db, r.withdrawals) }, r.replay ? 200 : 201);
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
