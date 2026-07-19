import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Apply a .sql file to the cloud DB, resolving the connection string the same way
 * the Lambda does: DATABASE_URL if set, else the SSM SecureString named by
 * DATABASE_URL_SSM (default /wcp/api/database-url). The password is fetched into
 * process memory and never printed. Needs AWS creds in the environment.
 *
 *   DATABASE_URL_SSM=/wcp/api/database-url tsx scripts/apply-sql.ts <file.sql>
 */
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: apply-sql.ts <path-to.sql>");

  let url = process.env.DATABASE_URL;
  const ssmName = process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url";
  if (!url) url = await fetchSsm(ssmName);
  if (!url) throw new Error(`no DATABASE_URL (and SSM ${ssmName} empty)`);

  const sqlText = readFileSync(resolve(process.cwd(), file), "utf8");
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  try {
    await sql.unsafe(sqlText);
    console.log(`applied: ${file}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((e) => {
  console.error("FAIL", e);
  process.exit(1);
});
