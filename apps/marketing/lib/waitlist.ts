import "server-only";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The waitlist storage seam. This is the single module to swap when moving the
 * store to a different backend — the UI and server action are unchanged.
 *
 * Double opt-in: a signup is saved PENDING (confirmed_at null) with a confirm_token,
 * a confirmation email is sent, and clicking the link marks confirmed_at. Only
 * confirmed rows are real, deliverable signups.
 *
 * Primary path: a Supabase `waitlist` table (idempotent on email). Fallback (no
 * Supabase env): a local JSON file so the flow works in dev — confirmation is a
 * no-op there.
 *
 * Expected columns (see migrations 0001–0013):
 *   id, email (unique on lower(email)), intent, created_at,
 *   confirmed_at, confirm_token (unique), confirmation_sent_at
 */

export type WaitlistIntent = "buy" | "sell" | "both" | null;

export type WaitlistEntry = {
  email: string;
  intent: WaitlistIntent;
};

/** pending = new signup; resend = existing unconfirmed (re-email); already_confirmed = done. */
export type SaveStatus = "pending" | "resend" | "already_confirmed";

export type SaveResult =
  | { ok: true; status: SaveStatus; token: string | null; duplicate: boolean }
  | { ok: false; error: "storage_error" };

export type ConfirmResult = { status: "confirmed" | "already" | "invalid" | "error" };

const SUPABASE_URL = process.env.SUPABASE_URL;
// Prefer the new-style secret API key (`sb_secret_...`), which bypasses RLS. Fall
// back to legacy keys. Server-side only — never expose to the browser.
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ??
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  process.env.SUPABASE_ANON_KEY;

const newToken = () => randomBytes(24).toString("base64url");
/** Escape LIKE wildcards so a case-insensitive email match is literal. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

async function client() {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: false } });
}

export async function saveWaitlistEntry(entry: WaitlistEntry): Promise<SaveResult> {
  const normalized = { ...entry, email: entry.email.trim().toLowerCase() };
  if (SUPABASE_URL && SUPABASE_KEY) return saveToSupabase(normalized);
  return saveToLocalFile(normalized);
}

async function saveToSupabase(entry: WaitlistEntry): Promise<SaveResult> {
  const supabase = await client();
  const token = newToken();

  const { error } = await supabase.from("waitlist").insert({
    email: entry.email,
    intent: entry.intent,
    confirm_token: token,
    confirmation_sent_at: new Date().toISOString(),
  });
  if (!error) return { ok: true, status: "pending", token, duplicate: false };

  // 23505 = unique_violation → already signed up (F-2 idempotent).
  if (error.code === "23505") {
    const { data, error: selErr } = await supabase
      .from("waitlist")
      .select("confirmed_at")
      .ilike("email", likeEscape(entry.email))
      .limit(1)
      .maybeSingle();
    if (selErr) {
      console.error("[waitlist] lookup after conflict failed:", selErr.message);
      return { ok: false, error: "storage_error" };
    }
    if (data?.confirmed_at) return { ok: true, status: "already_confirmed", token: null, duplicate: true };

    // Still pending → refresh the token and re-send the confirmation.
    const { error: updErr } = await supabase
      .from("waitlist")
      .update({ confirm_token: token, confirmation_sent_at: new Date().toISOString() })
      .ilike("email", likeEscape(entry.email));
    if (updErr) {
      console.error("[waitlist] token refresh failed:", updErr.message);
      return { ok: false, error: "storage_error" };
    }
    return { ok: true, status: "resend", token, duplicate: true };
  }

  console.error("[waitlist] supabase insert failed:", error.message);
  return { ok: false, error: "storage_error" };
}

export async function confirmWaitlistEntry(token: string): Promise<ConfirmResult> {
  if (!token || !(SUPABASE_URL && SUPABASE_KEY)) return { status: "invalid" };
  const supabase = await client();

  const { data, error } = await supabase
    .from("waitlist")
    .select("confirmed_at")
    .eq("confirm_token", token)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[waitlist] confirm lookup failed:", error.message);
    return { status: "error" };
  }
  if (!data) return { status: "invalid" };
  if (data.confirmed_at) return { status: "already" };

  const { error: updErr } = await supabase
    .from("waitlist")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("confirm_token", token);
  if (updErr) {
    console.error("[waitlist] confirm update failed:", updErr.message);
    return { status: "error" };
  }
  return { status: "confirmed" };
}

// ── Dev fallback (no Supabase): local JSON file; confirmation is a no-op ──────
async function saveToLocalFile(entry: WaitlistEntry): Promise<SaveResult> {
  console.warn("[waitlist] SUPABASE_URL not set — writing to local data/waitlist.json (dev).");
  const file = path.join(process.cwd(), "data", "waitlist.json");
  try {
    let list: WaitlistEntry[] = [];
    try {
      list = JSON.parse(await fs.readFile(file, "utf8")) as WaitlistEntry[];
    } catch {
      /* file doesn't exist yet */
    }
    if (list.some((e) => e.email.toLowerCase() === entry.email.toLowerCase())) {
      return { ok: true, status: "already_confirmed", token: null, duplicate: true };
    }
    list.push(entry);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(list, null, 2), "utf8");
    return { ok: true, status: "pending", token: newToken(), duplicate: false };
  } catch (err) {
    console.error("[waitlist] local file write failed:", err);
    return { ok: false, error: "storage_error" };
  }
}
