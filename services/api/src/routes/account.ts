import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { getDb } from "../db.js";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { AVATARS_BUCKET } from "../profiles/summary.js";
import { deleteStorageObject, getServiceKey, LISTING_IMAGES_BUCKET } from "../supabase.js";

/**
 * Account deletion — in the app (Privacy & security) and on the web
 * (wcpmarkets.com/delete-account), as Play requires for any app you can sign up in.
 *
 * Refused while money is in motion or owed: an open deal (anything not terminal — so a
 * live escrow, a dispute or an upcoming stay), a payout not yet settled, or money released
 * to the seller that they haven't withdrawn yet (deleting would strand it: the payout bank
 * account goes, and nobody could sign in to ask for it). Otherwise, at once:
 *
 *  - gone: addresses, saved items, watches, push devices, notifications, receipt email,
 *    payout bank account, blocks, recovery requests, staff roles, verification attempts;
 *    the avatar and KYC selfie files; photos of listings that never sold;
 *  - listings that never sold are taken down ('archived'); open quote requests closed;
 *  - the profile becomes "Deleted user" with every personal field cleared;
 *  - every session is revoked, and Supabase soft-deletes the sign-in account (phone and
 *    email scrubbed — the number can sign up afresh as a new account).
 *
 * Kept, nameless: completed deals, payments, payouts, reviews and disputes (the ledger
 * must balance, and they're financial records), messages in conversations the other
 * person still has, sold listings, and the verification *result* (match + keyed hash,
 * never the BVN/NIN itself — kept for KYC record-keeping).
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const DeletionBlockerSchema = z
  .object({
    /** deal = open deal; payout = on its way to the bank; balance = released, not withdrawn. */
    kind: z.enum(["deal", "payout", "balance"]),
    /** The deal's id for deal and balance, the payout's id for payout. */
    id: z.string().uuid(),
    /** What to show: the listing title for a deal, the amount (and listing) otherwise. */
    label: z.string(),
  })
  .openapi("DeletionBlocker");

const DeletionCheckSchema = z
  .object({
    canDelete: z.boolean(),
    /** Why not, when it can't — each must finish first. */
    blockers: z.array(DeletionBlockerSchema),
  })
  .openapi("DeletionCheck");

type Blocker = z.infer<typeof DeletionBlockerSchema>;

async function blockers(db: Sql, uid: string): Promise<Blocker[]> {
  const deals = await db<{ id: string; title: string | null }[]>`
    select d.id, l.title from public.deals d left join public.listings l on l.id = d.listing_id
    where (d.buyer_id = ${uid} or d.seller_id = ${uid}) and d.state <> all (public.deal_terminal_states())
    order by d.created_at desc limit 20`;
  const payouts = await db<{ id: string; amount: string }[]>`
    select id, amount_kobo::text as amount from public.payouts
    where seller_id = ${uid} and status = 'pending' limit 20`;
  // Released to the seller (seller_payable > 0 — a settled payout books it back out),
  // with no payout already on its way for that deal (those are listed above).
  const owed = await db<{ id: string; title: string | null; amount: string }[]>`
    select d.id, l.title, sum(le.amount_kobo)::text as amount
    from public.deals d
    join public.ledger_entries le on le.deal_id = d.id and le.account = 'seller_payable'
    left join public.listings l on l.id = d.listing_id
    where d.seller_id = ${uid}
      and not exists (select 1 from public.payouts p where p.deal_id = d.id and p.status = 'pending')
    group by d.id, l.title
    having sum(le.amount_kobo) > 0
    limit 20`;
  const naira = (kobo: string) => `₦${(Number(kobo) / 100).toLocaleString("en-NG")}`;
  return [
    ...deals.map((d) => ({ kind: "deal" as const, id: d.id, label: d.title ?? "A deal" })),
    ...payouts.map((p) => ({ kind: "payout" as const, id: p.id, label: `${naira(p.amount)} payout` })),
    ...owed.map((o) => ({ kind: "balance" as const, id: o.id, label: `${naira(o.amount)} from ${o.title ?? "a sale"}` })),
  ];
}

/** Supabase soft delete: keeps the auth row (other tables point at it), scrubs it, bars sign-in. */
async function softDeleteAuthUser(uid: string): Promise<boolean> {
  const key = await getServiceKey();
  const url = process.env.SUPABASE_URL;
  if (!key || !url) return false;
  const res = await fetch(`${url}/auth/v1/admin/users/${uid}`, {
    method: "DELETE",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ should_soft_delete: true }),
  });
  if (res.ok || res.status === 404) return true;
  console.error("[account] soft delete", res.status, (await res.text()).slice(0, 200));
  return false;
}

export function registerAccount(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "get",
      path: "/me/deletion",
      summary: "Can this account be deleted now — and if not, what must finish first",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        200: { description: "Check", content: { "application/json": { schema: DeletionCheckSchema } } },
        401: { description: "Unauthorized" },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const b = await blockers(db, c.get("user").sub);
      return c.json({ canDelete: b.length === 0, blockers: b }, 200);
    },
  );

  app.openapi(
    createRoute({
      method: "delete",
      path: "/me",
      summary: "Delete my account (anonymised in place; refused while a deal or payout is open, or money is waiting to be withdrawn)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      responses: {
        204: { description: "Deleted" },
        401: { description: "Unauthorized" },
        409: { description: "Something must finish first", content: { "application/json": { schema: DeletionCheckSchema } } },
        502: { description: "Data removed but the sign-in account couldn't be closed — retry", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);

      type Files = { avatar: string | null; selfie: string | null; photos: string[] };
      const out = await db.begin(async (tx) => {
        const q = tx as unknown as Sql;
        // Hold the profile so nothing new starts through this account mid-deletion.
        await q`select 1 from public.profiles where id = ${uid} for update`;
        const b = await blockers(q, uid);
        if (b.length) return { blocked: b, files: null };

        const [p] = await q<{ avatar_path: string | null }[]>`select avatar_path from public.profiles where id = ${uid}`;
        const [k] = await q<{ selfie_path: string | null }[]>`select selfie_path from public.kyc_verifications where user_id = ${uid}`;
        const unsold = await q<{ image_paths: string[] | null }[]>`
          select image_paths from public.listings where seller_id = ${uid} and status <> 'sold'`;
        // Taken down the way a seller takes one down ('archived'): 'removed' and
        // 'under_review' belong to moderation (listings_moderation_guard), so a listing
        // already there keeps its status — it loses its photos all the same.
        await q`update public.listings set status = 'archived', updated_at = now()
                where seller_id = ${uid} and status in ('draft', 'active')`;
        await q`update public.listings set image_paths = '{}', updated_at = now()
                where seller_id = ${uid} and status <> 'sold'`;
        await q`update public.quote_requests set status = 'closed', updated_at = now()
                where (buyer_id = ${uid} or seller_id = ${uid}) and status = 'open'`;
        await q`delete from public.addresses where user_id = ${uid}`;
        await q`delete from public.saved_listings where user_id = ${uid}`;
        await q`delete from public.watches where user_id = ${uid}`;
        await q`delete from public.push_devices where user_id = ${uid}`;
        await q`delete from public.notifications where user_id = ${uid}`;
        await q`delete from public.contact_emails where user_id = ${uid}`;
        await q`delete from public.payout_accounts where user_id = ${uid}`;
        await q`delete from public.blocks where blocker_id = ${uid} or blocked_id = ${uid}`;
        await q`delete from public.account_recoveries where account_id = ${uid}`;
        await q`delete from public.staff_roles where user_id = ${uid}`;
        await q`delete from public.kyc_attempts where user_id = ${uid}`;
        await q`update public.kyc_verifications set selfie_path = null where user_id = ${uid}`;
        await q`
          update public.profiles set
            display_name = 'Deleted user', phone = null, store_name = null, bio = null, avatar_path = null,
            state = null, city = null, show_last_seen = false, personalise_search = false, last_seen_at = null,
            deleted_at = now(), updated_at = now()
          where id = ${uid}`;
        await q`delete from auth.sessions where user_id = ${uid}`;
        const files: Files = {
          avatar: p?.avatar_path ?? null,
          selfie: k?.selfie_path ?? null,
          photos: unsold.flatMap((r) => r.image_paths ?? []),
        };
        return { blocked: null, files };
      });

      if (out.blocked) return c.json({ canDelete: false, blockers: out.blocked }, 409);

      // Files after commit, best-effort: a stray object is harmless; a rolled-back delete isn't.
      const f = out.files!;
      if (f.avatar) await deleteStorageObject(AVATARS_BUCKET, f.avatar);
      if (f.selfie) await deleteStorageObject("kyc-selfies", f.selfie);
      for (const path of f.photos) await deleteStorageObject(LISTING_IMAGES_BUCKET, path);

      if (!(await softDeleteAuthUser(uid))) return c.json({ error: "auth_close_failed" }, 502);
      console.log("[account] deleted", uid);
      return c.body(null, 204);
    },
  );
}
