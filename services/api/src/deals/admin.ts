import type { Sql } from "./commands.js";

/**
 * DB-backed staff authorization (M6). Identity comes from the Supabase JWT; whether a
 * caller may act as CX/support staff is decided HERE — so access can be granted or
 * revoked instantly (no token-refresh lag) and every resolution carries the rep's
 * user id. Grows into granular RBAC (a permissions table) without a rewrite.
 */
/**
 * The caller's staff role, or null. NEVER use `staffRole(...) != null` as a boolean
 * privilege gate — 'agent' exists for future granular RBAC and grants nothing today;
 * a mere-presence check would silently privilege it. Gate on the SPECIFIC role.
 */
export async function staffRole(db: Sql, userId: string): Promise<string | null> {
  const [r] = await db<{ role: string }[]>`
    select role from public.staff_roles where user_id = ${userId}
  `;
  return r?.role ?? null;
}

export async function isStaffAdmin(db: Sql, userId: string): Promise<boolean> {
  return (await staffRole(db, userId)) === "admin";
}
