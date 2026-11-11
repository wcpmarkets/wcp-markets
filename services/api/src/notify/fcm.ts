import { createSign } from "node:crypto";
import { fetchSsm } from "../secrets.js";

/**
 * Firebase Cloud Messaging, HTTP v1. Credentials are a Firebase service-account JSON
 * in SSM (FCM_SERVICE_ACCOUNT_SSM, default /wcp/api/fcm-service-account), or
 * FCM_SERVICE_ACCOUNT locally. Without one the mock stands in and nothing is sent —
 * the notification is still decided and logged as "mocked".
 *
 * No firebase-admin: an OAuth token is a signed JWT exchanged at Google's token
 * endpoint, cached until shortly before it expires.
 */
export type PushMessage = {
  token: string;
  title: string;
  body: string;
  /** String values only (FCM's rule); the app reads these to open the right screen. */
  data: Record<string, string>;
  /** Same tag replaces the previous notification (one per conversation). */
  tag?: string;
  /** Android notification channel. */
  channel: string;
};
/** gone = the token is dead (app uninstalled / token rotated): drop it. */
export type PushResult = { ok: true; id: string } | { ok: false; gone: boolean; error: string };

export interface PushSender {
  readonly name: "fcm" | "mock";
  send(m: PushMessage): Promise<PushResult>;
}

type ServiceAccount = { project_id: string; client_email: string; private_key: string };

class MockPush implements PushSender {
  readonly name = "mock" as const;
  async send(): Promise<PushResult> {
    return { ok: true, id: "mock" };
  }
}

class FcmPush implements PushSender {
  readonly name = "fcm" as const;
  private token: { value: string; until: number } | null = null;
  constructor(private sa: ServiceAccount) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.until) return this.token.value;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: this.sa.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const sig = createSign("RSA-SHA256").update(unsigned).sign(this.sa.private_key).toString("base64url");
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${sig}` }),
      signal: AbortSignal.timeout(8000),
    });
    const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !j.access_token) throw new Error(`fcm oauth ${res.status} ${j.error ?? ""}`.trim());
    this.token = { value: j.access_token, until: Date.now() + ((j.expires_in ?? 3600) - 300) * 1000 };
    return j.access_token;
  }

  async send(m: PushMessage): Promise<PushResult> {
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.sa.project_id}/messages:send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            token: m.token,
            notification: { title: m.title, body: m.body },
            data: m.data,
            android: { priority: "high", notification: { channel_id: m.channel, ...(m.tag ? { tag: m.tag } : {}) } },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await res.json().catch(() => ({}))) as {
        name?: string;
        error?: { status?: string; message?: string; details?: { errorCode?: string }[] };
      };
      if (res.ok && j.name) return { ok: true, id: j.name };
      const code = j.error?.details?.find((d) => d.errorCode)?.errorCode ?? j.error?.status ?? "";
      // UNREGISTERED: uninstalled / rotated. INVALID_ARGUMENT on a token is a malformed one.
      const gone = res.status === 404 || code === "UNREGISTERED" || (res.status === 400 && /token/i.test(j.error?.message ?? ""));
      return { ok: false, gone, error: `${res.status} ${code} ${j.error?.message ?? ""}`.trim().slice(0, 300) };
    } catch (e) {
      return { ok: false, gone: false, error: (e as Error).message.slice(0, 300) };
    }
  }
}

// A missing credential is looked up again every 5 minutes, so adding it in SSM reaches
// warm Lambdas without a redeploy (the same pattern as Paystack/Anthropic/Resend/Termii).
const RECHECK_MS = 5 * 60_000;
let sender: Promise<PushSender> | null = null;
let mockSince = 0;
export function getPushSender(): Promise<PushSender> {
  if (sender && mockSince && Date.now() - mockSince > RECHECK_MS) sender = null;
  sender ??= (async () => {
    const raw =
      process.env.FCM_SERVICE_ACCOUNT ??
      (await fetchSsm(process.env.FCM_SERVICE_ACCOUNT_SSM ?? "/wcp/api/fcm-service-account"));
    let sa: ServiceAccount | null = null;
    try {
      const j = raw ? (JSON.parse(raw) as Partial<ServiceAccount>) : null;
      if (j?.project_id && j.client_email && j.private_key) sa = j as ServiceAccount;
      else if (raw) console.error("[push] FCM service account is missing project_id/client_email/private_key");
    } catch {
      console.error("[push] FCM service account is not valid JSON");
    }
    if (!sa) {
      mockSince = Date.now();
      return new MockPush();
    }
    mockSince = 0;
    return new FcmPush(sa);
  })();
  return sender;
}
