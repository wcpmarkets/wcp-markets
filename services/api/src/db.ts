import postgres from "postgres";

/**
 * Lazy Postgres client for the Supabase database.
 *
 * Uses `DATABASE_URL` = the Supabase **Supavisor transaction-mode pooler** string
 * (port 6543). `prepare: false` is REQUIRED — transaction-mode pooling doesn't
 * support prepared statements, and leaving them on causes intermittent "prepared
 * statement does not exist" errors under warm Lambda reuse.
 *
 * Returns `null` when `DATABASE_URL` is unset (local dev without a DB) so handlers
 * can degrade gracefully instead of crashing.
 */
let client: postgres.Sql | null = null;
let resolved = false;

export function getDb(): postgres.Sql | null {
  if (resolved) return client;
  resolved = true;
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.warn("[db] DATABASE_URL not set — running without a database (dev).");
    client = null;
    return null;
  }
  client = postgres(url, {
    prepare: false, // Supavisor transaction mode
    max: 3, // small pool per warm Lambda
    idle_timeout: 20,
    connect_timeout: 10,
  });
  return client;
}
