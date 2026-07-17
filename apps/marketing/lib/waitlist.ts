import "server-only";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * The waitlist storage seam. This is the single function to swap when moving the
 * store to a different backend — everything else (UI, server action) is unchanged.
 *
 * Primary path: insert into a Supabase `waitlist` table (idempotent on email).
 * Fallback (no Supabase env yet): append to a local JSON file so the flow works
 * end-to-end in development before a Supabase project exists.
 *
 * Expected Supabase table:
 *   create table waitlist (
 *     id uuid primary key default gen_random_uuid(),
 *     email text not null unique,
 *     intent text,
 *     created_at timestamptz not null default now()
 *   );
 */

export type WaitlistIntent = "buy" | "sell" | null;

export type WaitlistEntry = {
  email: string;
  intent: WaitlistIntent;
};

export type SaveResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: "storage_error" };

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY;

export async function saveWaitlistEntry(
  entry: WaitlistEntry,
): Promise<SaveResult> {
  if (SUPABASE_URL && SUPABASE_KEY) {
    return saveToSupabase(entry);
  }
  return saveToLocalFile(entry);
}

async function saveToSupabase(entry: WaitlistEntry): Promise<SaveResult> {
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(SUPABASE_URL!, SUPABASE_KEY!, {
    auth: { persistSession: false },
  });

  const { error } = await supabase
    .from("waitlist")
    .insert({ email: entry.email, intent: entry.intent });

  if (!error) return { ok: true, duplicate: false };

  // 23505 = unique_violation → the email is already on the list (F-2 idempotent).
  if (error.code === "23505") return { ok: true, duplicate: true };

  console.error("[waitlist] supabase insert failed:", error.message);
  return { ok: false, error: "storage_error" };
}

async function saveToLocalFile(entry: WaitlistEntry): Promise<SaveResult> {
  console.warn(
    "[waitlist] SUPABASE_URL not set — writing to local data/waitlist.json (dev fallback).",
  );
  const file = path.join(process.cwd(), "data", "waitlist.json");
  try {
    let list: WaitlistEntry[] = [];
    try {
      list = JSON.parse(await fs.readFile(file, "utf8")) as WaitlistEntry[];
    } catch {
      // file doesn't exist yet
    }

    if (list.some((e) => e.email.toLowerCase() === entry.email.toLowerCase())) {
      return { ok: true, duplicate: true };
    }

    list.push(entry);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(list, null, 2), "utf8");
    return { ok: true, duplicate: false };
  } catch (err) {
    console.error("[waitlist] local file write failed:", err);
    return { ok: false, error: "storage_error" };
  }
}
