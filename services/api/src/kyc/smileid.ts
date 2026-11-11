import { createHmac, timingSafeEqual } from "node:crypto";
import { fetchSsm } from "../secrets.js";

/**
 * Smile ID (v3 API) — Biometric KYC: a live selfie compared against the photo NIBSS /
 * NIMC hold for a BVN/NIN. The app captures with the Smile ID SDK, using a short-lived
 * token minted here (the API key never leaves the server); Smile ID decides
 * asynchronously and we learn the result by webhook or by polling the job's status.
 *
 *   SMILEID_PARTNER_ID / SMILEID_API_KEY (local), or SSM
 *   SMILEID_PARTNER_ID_SSM (default /wcp/api/smileid-partner-id) and
 *   SMILEID_API_KEY_SSM    (default /wcp/api/smileid-api-key)
 *   SMILEID_ENV            "sandbox" (default) | "production"
 *   SMILEID_NIN_TYPE       Smile's id_type for an 11-digit NIN: NIN_SLIP (default) —
 *                          NIN_V2 needs an NIMC enterprise ID registered with Smile ID.
 *
 * Without credentials there is no client (null) and KYC stays on the mock match.
 */
export type SmileStatus = "clear" | "attention" | "block" | "error" | "processing" | "not_found";

const BASE = { sandbox: "https://testapi.smileidentity.com", production: "https://api.smileidentity.com" } as const;

export class SmileId {
  readonly sandbox: boolean;
  private readonly base: string;
  constructor(readonly partnerId: string, private readonly apiKey: string, env: "sandbox" | "production") {
    this.sandbox = env === "sandbox";
    this.base = BASE[env];
  }

  /** Smile's id_type for ours. */
  static idType(t: "bvn" | "nin"): string {
    return t === "bvn" ? "BVN" : (process.env.SMILEID_NIN_TYPE ?? "NIN_SLIP");
  }

  /**
   * A 15-minute token for one Biometric KYC, with the ID and the person bound into it
   * (Smile ID swaps the PII for references — the JWT never carries it), so the app can
   * only verify the number we hashed.
   */
  async token(p: {
    userId: string;
    idType?: "bvn" | "nin";
    idNumber?: string;
    givenNames?: string;
    lastName?: string;
    phone?: string | null;
    email?: string | null;
    callbackUrl?: string;
    privacyUrl?: string;
  }): Promise<string> {
    const form = new FormData();
    form.set("product", "biometric_kyc");
    form.set("user_id", p.userId);
    if (p.idType && p.idNumber) {
      const payload: Record<string, unknown> = {
        country: "NG",
        id_type: SmileId.idType(p.idType),
        id_number: p.idNumber,
        given_names: p.givenNames,
        last_name: p.lastName,
        ...(p.phone ? { phone_number: p.phone } : {}),
        ...(p.email ? { email: p.email } : {}),
        ...(p.callbackUrl ? { callback_url: p.callbackUrl } : {}),
        consent: {
          granted: true,
          granted_at: new Date().toISOString(),
          notice_language: "EN",
          notice_privacy_policy_url: p.privacyUrl ?? "https://wcpmarkets.com/privacy",
        },
      };
      form.set("payload", JSON.stringify(payload));
    }
    const res = await fetch(`${this.base}/v3/token`, {
      method: "POST",
      headers: { "smileid-partner-id": this.partnerId, "smileid-api-key": this.apiKey },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !j.token) throw new Error(`smileid token ${res.status} ${j.message ?? ""}`.trim());
    return j.token;
  }

  /** Where a job stands. `userId` is the one the job was made under (Smile scopes jobs to it). */
  async status(jobId: string, userId: string): Promise<SmileStatus> {
    const token = await this.token({ userId });
    const res = await fetch(`${this.base}/v3/status/${encodeURIComponent(jobId)}`, {
      headers: { "SmileID-Partner-ID": this.partnerId, "SmileID-Token": token },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404) return "not_found";
    const j = (await res.json().catch(() => ({}))) as { status?: SmileStatus; message?: string };
    if (res.status !== 200 && res.status !== 202) throw new Error(`smileid status ${res.status} ${j.message ?? ""}`.trim());
    return j.status ?? "processing";
  }

  /**
   * A webhook came from Smile ID: Response-Signature = base64 HMAC-SHA256 (API key) of
   * Response-Timestamp + partner ID + "sid_request". It signs the timestamp, not the
   * body — so we treat a webhook as a nudge and re-read the job's status from Smile
   * ourselves rather than trusting the body.
   */
  verifyWebhook(signature: string | undefined, timestamp: string | undefined, maxAgeMs = 10 * 60_000): boolean {
    if (!signature || !timestamp) return false;
    const t = Number.isNaN(Number(timestamp)) ? Date.parse(timestamp) : Number(timestamp) * (timestamp.length <= 10 ? 1000 : 1);
    if (!Number.isFinite(t) || Math.abs(Date.now() - t) > maxAgeMs) return false;
    const want = createHmac("sha256", this.apiKey).update(timestamp + this.partnerId + "sid_request").digest();
    const got = Buffer.from(signature, "base64");
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

// A missing key is looked up again every 5 minutes, so adding it in SSM reaches warm
// Lambdas without a redeploy.
const RECHECK_MS = 5 * 60_000;
let client: Promise<SmileId | null> | null = null;
let missingSince = 0;
const fromSsm = (name: string | undefined) => (name ? fetchSsm(name).catch(() => undefined) : Promise.resolve(undefined));

export function getSmileId(): Promise<SmileId | null> {
  if (client && missingSince && Date.now() - missingSince > RECHECK_MS) client = null;
  client ??= (async () => {
    const partnerId = process.env.SMILEID_PARTNER_ID ?? (await fromSsm(process.env.SMILEID_PARTNER_ID_SSM ?? "/wcp/api/smileid-partner-id"));
    const apiKey = process.env.SMILEID_API_KEY ?? (await fromSsm(process.env.SMILEID_API_KEY_SSM ?? "/wcp/api/smileid-api-key"));
    if (!partnerId || !apiKey) {
      missingSince = Date.now();
      return null;
    }
    missingSince = 0;
    return new SmileId(partnerId.trim(), apiKey.trim(), process.env.SMILEID_ENV === "production" ? "production" : "sandbox");
  })();
  return client;
}
