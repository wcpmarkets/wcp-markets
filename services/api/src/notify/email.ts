import { fetchSsm } from "../secrets.js";

/**
 * Email through Resend: the receipt-email confirmation link and email notifications.
 * Send-only key in SSM (RESEND_API_KEY_SSM, default /wcp/api/resend-api-key); sender
 * RESEND_FROM. Without a key nothing is sent and callers report "mocked".
 *
 * Never throws: an email failing must not undo or retry what it reports.
 */
export type EmailResult = { status: "sent" | "mocked" | "failed"; ref?: string; error?: string };

/** Cached once found; while missing, looked up again at most every 5 minutes. */
let resendKey: string | undefined;
let resendMissingAt = 0;
async function getResendKey(): Promise<string | undefined> {
  if (resendKey) return resendKey;
  if (Date.now() - resendMissingAt < 5 * 60_000) return undefined;
  resendKey =
    process.env.RESEND_API_KEY ??
    (await fetchSsm(process.env.RESEND_API_KEY_SSM ?? "/wcp/api/resend-api-key").catch(() => undefined));
  if (!resendKey) resendMissingAt = Date.now();
  return resendKey;
}

export async function sendEmail(p: { to: string; subject: string; text: string; html: string; headers?: Record<string, string> }): Promise<EmailResult> {
  const key = await getResendKey();
  if (!key) return { status: "mocked" };
  const from = (process.env.RESEND_FROM ?? "WCP Markets <wcp@wcpmarkets.com>").trim();
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: p.to, subject: p.subject, text: p.text, html: p.html, ...(p.headers ? { headers: p.headers } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    if (!res.ok) {
      // EMAIL_FAILED: the marker the CloudWatch alarm counts (infra: email_failures).
      console.error("[email] EMAIL_FAILED resend", res.status, body.slice(0, 200));
      // Resend's message, e.g. "The wcpmarkets.com domain is not verified…"
      const msg = (() => { try { return (JSON.parse(body) as { message?: string }).message; } catch { return undefined; } })();
      return { status: "failed", error: `${res.status} ${msg ?? ""}`.trim().slice(0, 300) };
    }
    const id = (() => { try { return (JSON.parse(body) as { id?: string }).id; } catch { return undefined; } })();
    return { status: "sent", ref: id };
  } catch (e) {
    console.error("[email] EMAIL_FAILED send failed:", e instanceof Error ? e.message : e);
    return { status: "failed", error: e instanceof Error ? e.message : String(e) };
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The one layout every WCP email shares: heading, paragraphs, optional button, footer. */
export function emailHtml(p: { heading: string; paragraphs: string[]; button?: { label: string; href: string }; footer: string }): string {
  return `<div style="font-family:system-ui,sans-serif;max-width:480px;margin:auto;padding:24px;color:#0b0d12">
<h2 style="margin:0 0 12px">${esc(p.heading)}</h2>
${p.paragraphs.map((t) => `<p style="line-height:1.5">${esc(t)}</p>`).join("\n")}
${p.button ? `<p style="margin:24px 0"><a href="${esc(p.button.href)}" style="background:#22d3ee;color:#0b0d12;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:700">${esc(p.button.label)}</a></p>` : ""}
<p style="color:#667;font-size:13px;line-height:1.5">${esc(p.footer)}</p></div>`;
}
