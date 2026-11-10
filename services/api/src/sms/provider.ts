import type { Sql } from "postgres";
import { fetchSsm } from "../secrets.js";

/**
 * Security SMS — alerts, never codes (Supabase Auth sends the OTPs). Termii is the
 * gateway (Nigerian, with a DND-bypassing transactional route); without an API key in
 * SSM the mock stands in and only logs. Every send, real or mocked, lands in
 * public.sms_log so a missing alert is visible rather than silent.
 *
 *   TERMII_API_KEY (local) or SSM TERMII_API_KEY_SSM (default /wcp/api/termii-api-key)
 *   TERMII_SENDER_ID  approved sender ID (default "WCPMarkets")
 *   TERMII_BASE_URL   default https://v3.api.termii.com
 */
export type SmsKind = "recovery_started" | "recovery_cancelled" | "recovery_completed" | "recovery_review";

export interface SmsSender {
  readonly name: "termii" | "mock";
  /** `to` in auth.users format (digits, country code, no '+'). */
  send(to: string, body: string): Promise<{ ok: boolean; ref?: string; error?: string }>;
}

class MockSms implements SmsSender {
  readonly name = "mock" as const;
  async send(): Promise<{ ok: boolean; ref?: string }> {
    return { ok: true, ref: `mock_sms_${Math.random().toString(36).slice(2, 10)}` };
  }
}

class TermiiSms implements SmsSender {
  readonly name = "termii" as const;
  constructor(private apiKey: string, private senderId: string, private base: string) {}
  async send(to: string, body: string) {
    try {
      const res = await fetch(`${this.base}/api/sms/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Never log this body: it carries the API key.
        body: JSON.stringify({ to, from: this.senderId, sms: body, type: "plain", channel: "dnd", api_key: this.apiKey }),
        signal: AbortSignal.timeout(8000),
      });
      const j = (await res.json().catch(() => ({}))) as { message_id?: string; message?: string };
      return res.ok && j.message_id ? { ok: true, ref: j.message_id } : { ok: false, error: `${res.status} ${j.message ?? ""}`.trim() };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

let sender: Promise<SmsSender> | null = null;
export function getSmsSender(): Promise<SmsSender> {
  sender ??= (async () => {
    const key = process.env.TERMII_API_KEY ?? (process.env.TERMII_API_KEY_SSM ? await fetchSsm(process.env.TERMII_API_KEY_SSM) : undefined);
    if (!key) return new MockSms();
    return new TermiiSms(key, process.env.TERMII_SENDER_ID ?? "WCPMarkets", (process.env.TERMII_BASE_URL ?? "https://v3.api.termii.com").replace(/\/$/, ""));
  })();
  return sender;
}

/** Send one security SMS and log it. Never throws — an alert failing must not undo the action it reports. */
export async function sendSecuritySms(db: Sql, p: { to: string; kind: SmsKind; body: string; recoveryId?: string }): Promise<boolean> {
  const s = await getSmsSender();
  const r = await s.send(p.to, p.body);
  const status = s.name === "mock" ? "mocked" : r.ok ? "sent" : "failed";
  await db`
    insert into public.sms_log (to_phone, kind, body, provider, provider_ref, status, error, recovery_id)
    values (${p.to}, ${p.kind}, ${p.body}, ${s.name}, ${r.ref ?? null}, ${status}, ${r.error ?? null}, ${p.recoveryId ?? null})
  `.catch((e) => console.error("[sms] log failed:", (e as Error).message));
  if (!r.ok) console.error(`[sms] ${p.kind} failed: ${r.error}`);
  return r.ok;
}
