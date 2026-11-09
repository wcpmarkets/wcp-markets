import { z } from "@hono/zod-openapi";
import type { Sql } from "../deals/commands.js";
import { createSignedDownloadUrl } from "../supabase.js";

export const AVATARS_BUCKET = "avatars";

/**
 * The public face of a user wherever another user sees them — a listing's seller
 * card, an inbox row, a deal. Never carries the phone number: chat stays in-app
 * (design 20m-privacy, "Phone number · Hidden · always").
 */
export const UserSummarySchema = z
  .object({
    id: z.string().uuid(),
    displayName: z.string().nullable(),
    storeName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    verified: z.boolean(),
  })
  .openapi("UserSummary");
export type UserSummary = z.infer<typeof UserSummarySchema>;

export async function avatarUrl(path: string | null): Promise<string | null> {
  return path ? createSignedDownloadUrl(AVATARS_BUCKET, path) : null;
}

/** Batch-load summaries; ids with no profile row still get a (blank) summary. */
export async function userSummaries(db: Sql, ids: string[]): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(ids)];
  const out = new Map<string, UserSummary>();
  if (unique.length === 0) return out;
  const rows = await db<
    { id: string; display_name: string | null; store_name: string | null; avatar_path: string | null; verification_level: number }[]
  >`
    select id, display_name, store_name, avatar_path, verification_level
    from public.profiles where id = any(${unique}::uuid[])
  `;
  const byId = new Map(rows.map((r) => [r.id, r]));
  await Promise.all(
    unique.map(async (id) => {
      const r = byId.get(id);
      out.set(id, {
        id,
        displayName: r?.display_name ?? null,
        storeName: r?.store_name ?? null,
        avatarUrl: await avatarUrl(r?.avatar_path ?? null),
        verified: (r?.verification_level ?? 1) >= 2,
      });
    }),
  );
  return out;
}

/** True if either user has blocked the other. */
export async function isBlockedEitherWay(db: Sql, a: string, b: string): Promise<boolean> {
  const [row] = await db<{ blocked: boolean }[]>`
    select exists (
      select 1 from public.blocks
      where (blocker_id = ${a} and blocked_id = ${b}) or (blocker_id = ${b} and blocked_id = ${a})
    ) as blocked
  `;
  return !!row?.blocked;
}
