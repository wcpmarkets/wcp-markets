import "server-only";

/**
 * Waitlist confirmation email (double opt-in) via Resend. Best-effort: a send
 * failure never throws into the join flow — the row is already saved and can be
 * re-emailed. Requires RESEND_API_KEY and a verified sending domain (DKIM/SPF) for
 * RESEND_FROM. Without the key, this no-ops with a warning (dev).
 */
const FROM = (process.env.RESEND_FROM ?? "WCP Markets <hello@wcpmarkets.com>").trim();
const SITE_URL = (process.env.SITE_URL ?? "https://www.wcpmarkets.com").trim().replace(/\/$/, "");

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

const FONT =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function html(url: string): string {
  // Table-based + inline styles for email-client compatibility. LIGHT theme so it
  // renders consistently across every client (incl. the Gmail mobile app, which
  // ignores color-scheme and inverts dark emails). WCP brand carries via the logo
  // chip, the purple #7C5CFF → cyan #22D3EE gradient hairline + CTA, and accents.
  // Gradients get a solid fallback so Outlook stays legible.
  //
  // The logo chip is a BAKED image (dark square + white logomark composited): Gmail
  // dark mode recolors CSS backgrounds but never image pixels, so a baked chip stays
  // near-black with the white mark visible in BOTH light and dark modes.
  const chip = `${SITE_URL}/wcp-logo-chip.png`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="supported-color-schemes" content="light" />
  </head>
  <body style="margin:0;padding:0;background-color:#EEF0F4;">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:#EEF0F4;">One tap to lock in early access to WCP Markets.</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#EEF0F4;">
      <tr>
        <td align="center" style="padding:40px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:#FFFFFF;border:1px solid #E4E7EC;border-radius:18px;overflow:hidden;">
            <tr>
              <td style="height:3px;background-color:#7C5CFF;background:linear-gradient(120deg,#7C5CFF,#22D3EE);font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td align="center" style="padding:36px 40px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                  <tr>
                    <td style="padding-right:11px;vertical-align:middle;">
                      <img src="${chip}" width="40" height="40" alt="WCP Markets" style="display:block;width:40px;height:40px;border:0;outline:none;border-radius:11px;" />
                    </td>
                    <td style="vertical-align:middle;font-family:${FONT};font-size:19px;font-weight:700;letter-spacing:-0.3px;color:#14171F;">WCP&nbsp;Markets</td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 40px 0;font-family:${FONT};">
                <h1 style="margin:0;font-size:23px;line-height:1.3;font-weight:700;color:#14171F;">Confirm your spot on the&nbsp;waitlist</h1>
                <p style="margin:14px 0 0;font-size:15px;line-height:1.65;color:#4A5163;">You're one tap from early access to Nigeria's escrow-backed marketplace &mdash; plus verified-seller onboarding before the crowd arrives.</p>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:28px 40px 0;">
                <table role="presentation" cellpadding="0" cellspacing="0" align="center">
                  <tr>
                    <td style="border-radius:11px;background-color:#7C5CFF;background:linear-gradient(120deg,#7C5CFF,#22D3EE);">
                      <a href="${url}" style="display:inline-block;padding:14px 30px;font-family:${FONT};font-size:15px;font-weight:700;color:#0B0D11;text-decoration:none;border-radius:11px;">Confirm my email</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:22px 40px 0;font-family:${FONT};">
                <p style="margin:0;font-size:12px;line-height:1.6;color:#8A93A6;">or paste this link into your browser</p>
                <p style="margin:5px 0 0;font-size:12px;line-height:1.6;word-break:break-all;"><a href="${url}" style="color:#6B46F0;text-decoration:none;">${url}</a></p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 40px 0;">
                <div style="height:1px;background-color:#E4E7EC;font-size:0;line-height:0;">&nbsp;</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:20px 40px 34px;font-family:${FONT};">
                <p style="margin:0;font-size:12px;line-height:1.65;color:#98A0AE;">Every naira sits in escrow until you confirm the deal. If you didn't sign up for WCP Markets, you can safely ignore this email.</p>
              </td>
            </tr>
          </table>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;">
            <tr>
              <td align="center" style="padding:18px 40px 0;font-family:${FONT};font-size:11px;color:#98A0AE;">© WCP Markets · Nigeria</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
