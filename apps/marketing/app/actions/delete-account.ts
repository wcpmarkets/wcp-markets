"use server";

/**
 * Account deletion from the web — the URL Google Play asks for alongside the in-app
 * option. Ownership is proven the same way the app proves it: a one-time code by SMS to
 * the account's phone (Supabase Auth). The resulting session is then used against the
 * API exactly as the app would: GET /me/deletion to show what happens (or what has to
 * finish first), DELETE /me to do it. All of it runs on the server, so the browser
 * never talks to Supabase or the API directly.
 *
 * Every phone number gets the same "if an account uses this number…" answer, so the
 * page can't be used to find out whether someone has an account.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
const API_URL = (process.env.WCP_API_URL ?? "https://a33kb0enoa.execute-api.eu-west-1.amazonaws.com").replace(/\/$/, "");

export type Blocker = { kind: "deal" | "payout"; id: string; label: string };

/** Nigerian numbers in any usual form → E.164 (+234…). null if it isn't one. */
function toE164(input: string): string | null {
  const d = input.replace(/[^\d+]/g, "");
  let n = d.startsWith("+") ? d.slice(1) : d;
  if (n.startsWith("0") && n.length === 11) n = "234" + n.slice(1);
  if (!/^234[789][01]\d{8}$/.test(n)) return null;
  return "+" + n;
}

export async function sendDeletionCode(phone: string): Promise<{ ok: true; phone: string } | { ok: false; error: "invalid_phone" | "unavailable" }> {
  const e164 = toE164(phone ?? "");
  if (!e164) return { ok: false, error: "invalid_phone" };
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: "unavailable" };
  try {
    // create_user: false — never makes an account for an unknown number. Its error for
    // one is swallowed so the answer doesn't reveal whether the number is registered.
    const res = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ phone: e164, create_user: false }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 429) return { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
  return { ok: true, phone: e164 };
}

type CheckResult =
  | { ok: true; token: string; canDelete: boolean; blockers: Blocker[] }
  | { ok: false; error: "bad_code" | "unavailable" };

export async function verifyDeletionCode(phone: string, code: string): Promise<CheckResult> {
  const e164 = toE164(phone ?? "");
  const token = (code ?? "").replace(/\D/g, "");
  if (!e164 || token.length < 4) return { ok: false, error: "bad_code" };
  if (!SUPABASE_URL || !SUPABASE_KEY) return { ok: false, error: "unavailable" };
  try {
    const v = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sms", phone: e164, token }),
      signal: AbortSignal.timeout(8000),
    });
    if (!v.ok) return { ok: false, error: "bad_code" };
    const { access_token } = (await v.json()) as { access_token?: string };
    if (!access_token) return { ok: false, error: "bad_code" };
    const c = await fetch(`${API_URL}/me/deletion`, {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!c.ok) return { ok: false, error: "unavailable" };
    const check = (await c.json()) as { canDelete: boolean; blockers: Blocker[] };
    return { ok: true, token: access_token, canDelete: check.canDelete, blockers: check.blockers };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

export async function confirmDeletion(
  token: string,
): Promise<{ ok: true } | { ok: false; error: "blocked"; blockers: Blocker[] } | { ok: false; error: "expired" | "unavailable" }> {
  if (!token) return { ok: false, error: "expired" };
  try {
    const r = await fetch(`${API_URL}/me`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (r.status === 204) return { ok: true };
    if (r.status === 409) return { ok: false, error: "blocked", blockers: ((await r.json()) as { blockers: Blocker[] }).blockers };
    if (r.status === 401) return { ok: false, error: "expired" };
    return { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
