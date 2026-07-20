import "server-only";

/**
 * Waitlist confirmation email (double opt-in) via Resend. Best-effort: a send
 * failure never throws into the join flow — the row is already saved and can be
 * re-emailed. Requires RESEND_API_KEY and a verified sending domain (DKIM/SPF) for
 * RESEND_FROM. Without the key, this no-ops with a warning (dev).
 */
const FROM = process.env.RESEND_FROM ?? "WCP Markets <hello@wcpmarkets.com>";
const SITE_URL = (process.env.SITE_URL ?? "https://www.wcpmarkets.com").replace(/\/$/, "");

export async function sendConfirmationEmail(p: { email: string; token: string }): Promise<boolean> {
  const key = process.env.RESEND_API_KEY;
  if (!key) {
    console.warn("[email] RESEND_API_KEY not set — confirmation email skipped (dev).");
    return false;
  }
  const url = `${SITE_URL}/confirm?token=${encodeURIComponent(p.token)}`;
  try {
    const { Resend } = await import("resend");
    const resend = new Resend(key);
    const { error } = await resend.emails.send({
      from: FROM,
      to: p.email,
      subject: "Confirm your spot on the WCP Markets waitlist",
      html: html(url),
      text: text(url),
    });
    if (error) {
      console.error("[email] resend error:", error);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[email] send failed:", e);
    return false;
  }
}

function text(url: string): string {
  return [
    "One more step to join the WCP Markets waitlist.",
    "",
    "Confirm your email to lock in early access:",
    url,
    "",
    "If you didn't sign up, you can ignore this email.",
    "— WCP Markets",
  ].join("\n");
}

function html(url: string): string {
  // Table-based + inline styles for email-client compatibility. Brand: canvas
  // #0D0F14, purple #7C5CFF → cyan #22D3EE gradient, text #EAEDF2 / #8A93A6.
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0B0D11;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0B0D11;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#12151C;border:1px solid #232838;border-radius:16px;">
            <tr>
              <td style="padding:32px 32px 8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <div style="font-size:18px;font-weight:700;color:#EAEDF2;letter-spacing:-0.01em;">WCP&nbsp;Markets</div>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <h1 style="margin:12px 0 8px;font-size:22px;line-height:1.3;color:#EAEDF2;font-weight:700;">Confirm your spot on the waitlist</h1>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#C6CCD8;">
                  You're almost in. Tap the button below to confirm your email and lock in early access &mdash; including verified-seller onboarding before the crowd arrives.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 8px;">
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:10px;background:linear-gradient(120deg,#7C5CFF,#22D3EE);">
                      <a href="${url}" style="display:inline-block;padding:13px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#0B0D11;text-decoration:none;border-radius:10px;">Confirm my email</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
                <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:#8A93A6;">Or paste this link into your browser:</p>
                <p style="margin:0 0 20px;font-size:12px;line-height:1.6;word-break:break-all;"><a href="${url}" style="color:#22D3EE;text-decoration:none;">${url}</a></p>
                <p style="margin:0;font-size:12px;line-height:1.6;color:#707A8C;">If you didn't sign up for WCP Markets, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
