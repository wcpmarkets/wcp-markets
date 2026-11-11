import { createHash, randomBytes } from "node:crypto";
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { Sql } from "postgres";
import { getDb } from "../db.js";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { clientIp } from "../middleware/rate-limit.js";
import { fetchSsm } from "../secrets.js";
import { getServiceKey } from "../supabase.js";

/**
 * A receipt / contact email for phone-first accounts (asked for, skippably, at
 * checkout). Saving one holds it unconfirmed in `contact_emails` — Paystack receipts
 * use it at once — and emails a link; following the link makes it the account's
 * confirmed email in Supabase Auth, which sign-in and account recovery trust.
 *
 * Payment never waits on any of this: no Resend key, a send failure, or a link never
 * clicked all leave the buyer able to pay.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

/** Reserved / non-deliverable endings; Paystack rejects them, and nobody reads them. */
export const UNDELIVERABLE = /\.(local|invalid|test|example|localhost)$/i;

const ContactEmailRequestSchema = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .openapi("ContactEmailRequest");

const ContactEmailSchema = z
  .object({
    email: z.string(),
    /** True once the link was followed (or the address already was the account's). */
    verified: z.boolean(),
    /** False when the confirmation email couldn't be sent; the address is still saved. */
    verificationSent: z.boolean(),
  })
  .openapi("ContactEmail");

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const TOKEN_TTL_H = 48;

/** The account's confirmed email, and a pending (unconfirmed) one if it differs. */
export async function emailsFor(db: Sql, userId: string): Promise<{ email: string | null; pendingEmail: string | null }> {
  const [r] = await db<{ email: string | null; confirmed: boolean; pending: string | null }[]>`
    select nullif(u.email, '') as email, u.email_confirmed_at is not null as confirmed, c.email as pending
    from auth.users u left join public.contact_emails c on c.user_id = u.id
    where u.id = ${userId}`;
  const email = r?.email && r.confirmed && !UNDELIVERABLE.test(r.email) ? r.email : null;
  const pendingEmail = r?.pending && r.pending.toLowerCase() !== email?.toLowerCase() ? r.pending : null;
  return { email, pendingEmail };
}

let resendKey: Promise<string | undefined> | null = null;
function getResendKey() {
  resendKey ??= (async () => process.env.RESEND_API_KEY ?? (process.env.RESEND_API_KEY_SSM ? await fetchSsm(process.env.RESEND_API_KEY_SSM) : undefined))();
  return resendKey;
}

async function sendVerifyEmail(to: string, link: string): Promise<boolean> {
  const key = await getResendKey();
  if (!key) {
    console.warn("[contact-email] no Resend key — confirmation not sent");
    return false;
  }
  const from = (process.env.RESEND_FROM ?? "WCP Markets <hello@wcpmarkets.com>").trim();
  const text = `Confirm this email for your WCP Markets account:\n\n${link}\n\nWe'll send your payment receipts here. The link works for ${TOKEN_TTL_H} hours. If you didn't ask for this, ignore this email.`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b0d12">
<h2 style="margin:0 0 12px">Confirm your email</h2>
<p>Tap below to confirm this email for your WCP Markets account. We'll send your payment receipts here.</p>
<p style="margin:24px 0"><a href="${link}" style="background:#22d3ee;color:#0b0d12;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">Confirm email</a></p>
<p style="color:#667;font-size:13px">The link works for ${TOKEN_TTL_H} hours. If you didn't ask for this, ignore this email.</p></div>`;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject: "Confirm your email for WCP Markets", text, html }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.error("[contact-email] resend", res.status, (await res.text()).slice(0, 200));
    return res.ok;
  } catch (e) {
    console.error("[contact-email] send failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Make `email` the account's confirmed email in Supabase Auth. */
async function confirmOnAccount(userId: string, email: string): Promise<"ok" | "taken" | "failed"> {
  const key = await getServiceKey();
  const url = process.env.SUPABASE_URL;
  if (!key || !url) return "failed";
  const res = await fetch(`${url}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, email_confirm: true }),
  });
  if (res.ok) return "ok";
  const body = await res.text();
  if (res.status === 422 && /exist|already/i.test(body)) return "taken";
  console.error("[contact-email] admin update", res.status, body.slice(0, 200));
  return "failed";
}

function page(title: string, msg: string, status: 200 | 400 | 409 | 500 = 200) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head>
<body style="margin:0;background:#0b0d12;color:#e8ecf3;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center">
<div style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:22px">${title}</h1><p style="color:#9aa3b2;line-height:1.5">${msg}</p></div></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export function registerContactEmail(app: OpenAPIHono<AuthEnv>) {
  // ── PUT /me/email — save a receipt email, send its confirmation link ──────
  app.openapi(
    createRoute({
      method: "put",
      path: "/me/email",
      summary: "Save a receipt/contact email (unconfirmed until its emailed link is followed)",
      tags: ["users"],
      security: [{ bearerAuth: [] }],
      middleware: [auth] as const,
      request: { body: { content: { "application/json": { schema: ContactEmailRequestSchema } } } },
      responses: {
        200: { description: "Saved", content: { "application/json": { schema: ContactEmailSchema } } },
        400: { description: "Not a usable address", content: { "application/json": { schema: ErrorSchema } } },
        401: { description: "Unauthorized" },
        409: { description: "Already another account's email", content: { "application/json": { schema: ErrorSchema } } },
        429: { description: "Too many changes", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Database unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const uid = c.get("user").sub;
      const db = await getDb();
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      const { email } = c.req.valid("json");
      if (UNDELIVERABLE.test(email)) return c.json({ error: "invalid_email" }, 400);

      const current = await emailsFor(db, uid);
      if (current.email?.toLowerCase() === email) return c.json({ email, verified: true, verificationSent: false }, 200);
      const [other] = await db`select 1 from auth.users where lower(email) = ${email} and id <> ${uid} and deleted_at is null limit 1`;
      if (other) return c.json({ error: "email_in_use" }, 409);

      // Each save sends an email: cap it (per account and per IP).
      for (const [bucket, limit] of [[`contact-email:${uid}`, 5], [`contact-email:ip:${clientIp(c)}`, 20]] as const) {
        const [r] = await db<{ allowed: boolean }[]>`select public.consume_rate_limit(${bucket}, ${limit}, 3600) as allowed`;
        if (!r?.allowed) return c.json({ error: "rate_limited" }, 429);
      }

      const token = randomBytes(32).toString("base64url");
      await db`
        insert into public.contact_emails (user_id, email, token_hash, token_expires_at, verified_at, updated_at)
        values (${uid}, ${email}, ${sha256(token)}, now() + ${`${TOKEN_TTL_H} hours`}::interval, null, now())
        on conflict (user_id) do update set email = excluded.email, token_hash = excluded.token_hash,
          token_expires_at = excluded.token_expires_at, verified_at = null, updated_at = now()`;
      const base = (process.env.PUBLIC_API_URL ?? new URL(c.req.url).origin).replace(/\/$/, "");
      const sent = await sendVerifyEmail(email, `${base}/email/verify?t=${token}`);
      return c.json({ email, verified: false, verificationSent: sent }, 200);
    },
  );

  // ── GET /email/verify?t=… — the emailed link (a browser page, no auth) ────
  app.get("/email/verify", async (c) => {
    const t = c.req.query("t") ?? "";
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(t)) return page("Link not valid", "This confirmation link is incomplete. Open it from the email again.", 400);
    const db = await getDb();
    if (!db) return page("Try again shortly", "We couldn't confirm your email just now. Please try the link again in a minute.", 500);
    const [row] = await db<{ user_id: string; email: string; expired: boolean }[]>`
      select user_id, email, token_expires_at < now() as expired from public.contact_emails where token_hash = ${sha256(t)}`;
    if (!row) return page("Link already used", "This link has been used or replaced by a newer one. If your email isn't confirmed yet, add it again at checkout.", 400);
    if (row.expired) return page("Link expired", "This link has expired. Add your email again at checkout to get a new one.", 400);

    const r = await confirmOnAccount(row.user_id, row.email);
    if (r === "taken") return page("Email already in use", "That email is already on another WCP Markets account, so it can't be added to this one.", 409);
    if (r === "failed") return page("Try again shortly", "We couldn't confirm your email just now. Please try the link again in a minute.", 500);
    await db`update public.contact_emails set verified_at = now(), token_hash = null, token_expires_at = null, updated_at = now()
             where user_id = ${row.user_id}`;
    return page("Email confirmed ✓", `${row.email} is now on your WCP Markets account. You can close this page.`);
  });
}
