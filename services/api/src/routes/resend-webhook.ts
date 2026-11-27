import { createHmac, timingSafeEqual } from "node:crypto";
import type { OpenAPIHono } from "@hono/zod-openapi";
import type { AuthEnv } from "../middleware/auth.js";
import { fetchSsm } from "../secrets.js";

/**
 * POST /webhooks/resend — Resend's delivery events for every email sent from
 * wcpmarkets.com (the app's and the marketing site's). A bounce, spam complaint,
 * failure or long delay is logged with the EMAIL_FAILED marker, which a CloudWatch
 * alarm watches (infra: email_failures) and emails the team about.
 *
 * Signed the Svix way: HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>" with the
 * base64 part of the endpoint's "whsec_…" secret (SSM RESEND_WEBHOOK_SECRET_SSM,
 * default /wcp/api/resend-webhook-secret). Until that secret exists the endpoint
 * answers 503, so Resend keeps the events and retries.
 *
 * Logs carry the event type, Resend's email id, subject and the recipient's domain —
 * never the full address.
 */
const ALERT_TYPES = new Set(["email.bounced", "email.complained", "email.failed", "email.delivery_delayed"]);
const TOLERANCE_S = 5 * 60;

let secret: string | undefined;
let missingAt = 0;
async function getSecret(): Promise<string | undefined> {
  if (secret) return secret;
  if (Date.now() - missingAt < 5 * 60_000) return undefined;
  secret =
    process.env.RESEND_WEBHOOK_SECRET ??
    (await fetchSsm(process.env.RESEND_WEBHOOK_SECRET_SSM ?? "/wcp/api/resend-webhook-secret").catch(() => undefined));
  if (!secret) missingAt = Date.now();
  return secret;
}

/** True when one of the v1 signatures in `header` matches. Exported for tests. */
export function verifySvix(raw: string, id: string, ts: string, header: string, whsec: string, nowS = Date.now() / 1000): boolean {
  const t = Number(ts);
  if (!id || !Number.isFinite(t) || Math.abs(nowS - t) > TOLERANCE_S) return false;
  const key = Buffer.from(whsec.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${raw}`).digest();
  return header.split(" ").some((part) => {
    const [v, sig] = part.split(",");
    if (v !== "v1" || !sig) return false;
    const got = Buffer.from(sig, "base64");
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

type ResendEvent = {
  type?: string;
  data?: { email_id?: string; subject?: string; to?: string[] | string; bounce?: { type?: string; message?: string }; failed?: { reason?: string } };
};

export function registerResendWebhook(app: OpenAPIHono<AuthEnv>) {
  app.post("/webhooks/resend", async (c) => {
    const raw = await c.req.text();
    const whsec = await getSecret();
    if (!whsec) return c.json({ error: "not_configured" }, 503);
    const ok = verifySvix(raw, c.req.header("svix-id") ?? "", c.req.header("svix-timestamp") ?? "", c.req.header("svix-signature") ?? "", whsec);
    if (!ok) return c.json({ error: "bad_signature" }, 401);

    let ev: ResendEvent;
    try {
      ev = JSON.parse(raw) as ResendEvent;
    } catch {
      return c.json({ error: "bad_json" }, 400);
    }
    if (ev.type && ALERT_TYPES.has(ev.type)) {
      const to = ([] as string[]).concat(ev.data?.to ?? []);
      const domains = [...new Set(to.map((a) => a.split("@")[1] ?? "?"))].join(",");
      const why = ev.data?.bounce?.message ?? ev.data?.bounce?.type ?? ev.data?.failed?.reason ?? "";
      // EMAIL_FAILED: the marker the CloudWatch alarm counts.
      console.error(
        `[email] EMAIL_FAILED webhook ${ev.type} id=${ev.data?.email_id ?? "?"} to=@${domains} subject="${(ev.data?.subject ?? "").slice(0, 80)}" ${why.slice(0, 200)}`,
      );
    }
    return c.json({ ok: true }, 200);
  });
}
