import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { components } from "@wcp/api-client";
import { ADMIN_COOKIE, API_URL, parseSession } from "./admin-session";

/** Staff console → API, server-side, as the signed-in staff member. */

type S = components["schemas"];
export type DisputeQueueItem = S["DisputeQueueItem"];
export type DisputeDetail = S["DisputeDetail"];
export type ReportQueueItem = S["ReportQueueItem"];
export type AdminRecovery = S["AdminRecovery"];
export type UserSummary = S["UserSummary"];

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string };

async function token(): Promise<string> {
  const s = parseSession((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!s) redirect("/admin/login");
  return s.access;
}

/** Call the API; 401/403 send the person back to sign-in, other failures come back as values. */
export async function adminApi<T>(path: string, init?: { method?: string; body?: unknown }): Promise<ApiResult<T>> {
  const t = await token();
  let r: Response;
  try {
    r = await fetch(`${API_URL}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${t}`,
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return { ok: false, status: 0, error: "unreachable" };
  }
  if (r.status === 401) redirect("/admin/login?expired=1");
  const body = (await r.json().catch(() => null)) as unknown;
  if (r.status === 403 && (body as { error?: string } | null)?.error === "forbidden") redirect("/admin/login?denied=1");
  if (!r.ok) return { ok: false, status: r.status, error: (body as { error?: string } | null)?.error ?? `http_${r.status}` };
  return { ok: true, data: body as T };
}

export const naira = (kobo: number) =>
  "₦" + (kobo / 100).toLocaleString("en-NG", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

export const when = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString("en-GB", { timeZone: "Africa/Lagos", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "—";

export const ago = (iso: string | null | undefined) => {
  if (!iso) return "—";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};

export const who = (u: UserSummary | null | undefined) => u?.storeName || u?.displayName || "Unnamed";
