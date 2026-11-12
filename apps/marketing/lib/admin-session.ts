/**
 * The staff console's session cookie — shared by middleware (edge) and server code,
 * so it imports nothing Node-only.
 *
 * One httpOnly cookie scoped to /admin holds the staff member's Supabase tokens. The
 * browser never sees them and never talks to Supabase or the API; every call is made
 * server-side. A session lasts at most MAX_AGE_S regardless of refreshes, so a
 * forgotten laptop doesn't stay signed in to the dispute desk for weeks.
 */
export const ADMIN_COOKIE = "wcp_admin";
export const MAX_AGE_S = 12 * 60 * 60;

export type AdminSession = {
  access: string;
  refresh: string;
  /** Access-token expiry, unix seconds. */
  exp: number;
  /** When the person signed in, unix seconds — fixes the session's hard end. */
  since: number;
};

export function parseSession(raw: string | undefined): AdminSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as Partial<AdminSession>;
    if (typeof s.access !== "string" || typeof s.refresh !== "string" || typeof s.exp !== "number" || typeof s.since !== "number") return null;
    if (Date.now() / 1000 > s.since + MAX_AGE_S) return null;
    return s as AdminSession;
  } catch {
    return null;
  }
}

export const cookieOptions = (since: number) => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/admin",
  maxAge: Math.max(0, Math.floor(since + MAX_AGE_S - Date.now() / 1000)),
});

export const SUPABASE_URL = process.env.SUPABASE_URL;
// Only the public key is needed: OTP send/verify and refresh act as the person.
export const SUPABASE_PUBLIC_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
export const API_URL = (process.env.WCP_API_URL ?? "https://a33kb0enoa.execute-api.eu-west-1.amazonaws.com").replace(/\/$/, "");

/** Swap a refresh token for a new session. null when it's no longer valid. */
export async function refreshSession(s: AdminSession): Promise<AdminSession | null> {
  if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLIC_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: s.refresh }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token?: string; refresh_token?: string; expires_at?: number };
    if (!j.access_token || !j.refresh_token || !j.expires_at) return null;
    return { access: j.access_token, refresh: j.refresh_token, exp: j.expires_at, since: s.since };
  } catch {
    return null;
  }
}
