"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { adminApi } from "@/lib/admin";
import { ADMIN_COOKIE, API_URL, SUPABASE_PUBLIC_KEY, SUPABASE_URL, cookieOptions } from "@/lib/admin-session";

/** Nigerian numbers in any usual form → E.164 (+234…). null if it isn't one. */
function toE164(input: string): string | null {
  const d = input.replace(/[^\d+]/g, "");
  let n = d.startsWith("+") ? d.slice(1) : d;
  if (n.startsWith("0") && n.length === 11) n = "234" + n.slice(1);
  if (!/^234[789][01]\d{8}$/.test(n)) return null;
  return "+" + n;
}

export type LoginState = { step: "phone" | "code"; phone?: string; error?: string };

/**
 * Two-step sign-in in one action: phone → SMS code → verify. The same answer comes
 * back for every number (create_user: false, errors swallowed), so the page can't
 * be used to discover who has an account. Only a staff admin gets a session — the
 * API's own /admin check decides that, not this site.
 */
export async function adminLogin(prev: LoginState, form: FormData): Promise<LoginState> {
  if (!SUPABASE_URL || !SUPABASE_PUBLIC_KEY) return { ...prev, error: "Sign-in isn't configured on this server." };

  if (prev.step === "phone") {
    const phone = toE164(String(form.get("phone") ?? ""));
    if (!phone) return { step: "phone", error: "Enter a Nigerian mobile number." };
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/otp`, {
        method: "POST",
        headers: { apikey: SUPABASE_PUBLIC_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ phone, create_user: false }),
        signal: AbortSignal.timeout(8000),
      });
      if (r.status === 429) return { step: "phone", error: "Too many codes requested. Wait a minute and try again." };
    } catch {
      return { step: "phone", error: "Couldn't reach sign-in. Try again." };
    }
    return { step: "code", phone };
  }

  const phone = prev.phone ?? "";
  const code = String(form.get("code") ?? "").replace(/\D/g, "");
  if (code.length < 4) return { ...prev, error: "Enter the code from the SMS." };
  let s: { access_token?: string; refresh_token?: string; expires_at?: number };
  try {
    const v = await fetch(`${SUPABASE_URL}/auth/v1/verify`, {
      method: "POST",
      headers: { apikey: SUPABASE_PUBLIC_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "sms", phone, token: code }),
      signal: AbortSignal.timeout(8000),
    });
    if (!v.ok) return { ...prev, error: "That code didn't work. Check it, or start again for a new one." };
    s = await v.json();
  } catch {
    return { ...prev, error: "Couldn't reach sign-in. Try again." };
  }
  if (!s.access_token || !s.refresh_token || !s.expires_at) return { ...prev, error: "Sign-in failed. Try again." };

  // Staff only: ask the API, which checks staff_roles.
  const probe = await fetch(`${API_URL}/admin/recoveries`, {
    headers: { Authorization: `Bearer ${s.access_token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  if (!probe) return { step: "phone", error: "Couldn't reach the API. Try again." };
  if (probe.status === 403) return { step: "phone", error: "This account doesn't have staff access." };
  if (!probe.ok) return { step: "phone", error: "The API isn't answering properly. Try again shortly." };

  const since = Math.floor(Date.now() / 1000);
  (await cookies()).set(
    ADMIN_COOKIE,
    JSON.stringify({ access: s.access_token, refresh: s.refresh_token, exp: s.expires_at, since }),
    cookieOptions(since),
  );
  redirect("/admin");
}

export async function adminLogout() {
  (await cookies()).delete({ name: ADMIN_COOKIE, path: "/admin" });
  redirect("/admin/login");
}

export type ActionState = { ok?: boolean; error?: string; message?: string };

const ERRORS: Record<string, string> = {
  conflict_of_interest: "You're a party to this — another staff member has to decide it.",
  not_resolvable: "This deal is no longer in dispute (it may have been auto-refunded or already decided).",
  conflict: "Someone else changed this deal just now. Reload and check before deciding.",
  not_found: "It's no longer open — probably already handled.",
  wrong_state: "It's no longer awaiting a decision.",
  no_listing: "There's no listing to remove for this report.",
  note_required: "Write the reason — the seller reads it.",
  unreachable: "Couldn't reach the API. Nothing was changed.",
};
const explain = (e: string) => ERRORS[e] ?? `The API refused (${e}). Nothing was changed.`;
const UUID = /^[0-9a-f-]{36}$/i;

export async function resolveDispute(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("dealId") ?? "");
  const resolution = String(form.get("resolution") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!UUID.test(id) || (resolution !== "release" && resolution !== "refund")) return { error: "Bad request." };
  if (note.length < 10) return { error: "Write a short note on why (at least 10 characters) — it's the record of this decision." };
  const r = await adminApi(`/deals/${id}/dispute/resolve`, { method: "POST", body: { resolution, note: note.slice(0, 2000) } });
  if (!r.ok) return { error: explain(r.error) };
  revalidatePath("/admin", "layout");
  return { ok: true, message: resolution === "release" ? "Released to the seller." : "Refunded to the buyer." };
}

export async function resolveReport(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("reportId") ?? "");
  const action = String(form.get("action") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!UUID.test(id) || !["dismiss", "remove_listing", "uphold"].includes(action)) return { error: "Bad request." };
  const r = await adminApi<{ resolved: number; listingStatus: string | null }>(`/admin/reports/${id}/resolve`, {
    method: "POST",
    body: { action, ...(note ? { note: note.slice(0, 500) } : {}) },
  });
  if (!r.ok) return { error: explain(r.error) };
  // No revalidate: the card stays and shows the outcome; counts refresh on the next page load.
  const n = r.data.resolved;
  return { ok: true, message: `Closed ${n} report${n === 1 ? "" : "s"}${r.data.listingStatus ? ` · listing is now ${r.data.listingStatus.replace("_", " ")}` : ""}.` };
}

export async function reviewListing(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("listingId") ?? "");
  const decision = String(form.get("decision") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!UUID.test(id) || (decision !== "approve" && decision !== "reject")) return { error: "Bad request." };
  if (decision === "reject" && note.length < 10) return { error: "Write the reason (at least 10 characters) — the seller reads it." };
  const r = await adminApi(`/admin/listings/${id}/review`, {
    method: "POST",
    body: { decision, ...(note ? { note: note.slice(0, 500) } : {}) },
  });
  if (!r.ok) return { error: explain(r.error) };
  return { ok: true, message: decision === "approve" ? "Approved — it's on sale and the seller was told." : "Rejected — the seller was told why." };
}

export async function decideRecovery(_: ActionState, form: FormData): Promise<ActionState> {
  const id = String(form.get("recoveryId") ?? "");
  const decision = String(form.get("decision") ?? "");
  if (!UUID.test(id) || (decision !== "approve" && decision !== "reject")) return { error: "Bad request." };
  const r = await adminApi(`/admin/recoveries/${id}/${decision}`, { method: "POST" });
  if (!r.ok) return { error: explain(r.error) };
  // No revalidate: the card stays and shows the outcome; counts refresh on the next page load.
  return { ok: true, message: decision === "approve" ? "Approved — the 24-hour hold has started and both numbers get an SMS." : "Rejected." };
}
