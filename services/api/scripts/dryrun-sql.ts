import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { fetchSsm } from "../src/secrets.js";

/**
 * Run a .sql file inside a transaction on the cloud DB, print a few probes, then
 * ROLL BACK — nothing persists. Validates a migration against the real schema
 * before it's applied for real with apply-sql.ts.
 *
 *   tsx scripts/dryrun-sql.ts <file.sql>
 */
class Rollback extends Error {}
async function main() {
  const file = process.argv[2];
  if (!file) throw new Error("usage: dryrun-sql.ts <path-to.sql>");
  let url = process.env.DATABASE_URL;
  if (!url) url = await fetchSsm(process.env.DATABASE_URL_SSM ?? "/wcp/api/database-url");
  if (!url) throw new Error("no DATABASE_URL");
  const sqlText = readFileSync(resolve(process.cwd(), file), "utf8");
  const sql = postgres(url, { prepare: false, max: 1, connect_timeout: 15 });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe(sqlText);
      // Second pass proves it's re-runnable.
      await tx.unsafe(sqlText);
      const probes = await tx.unsafe(process.env.PROBE ?? "select 1 as ok");
      console.log("probe:", JSON.stringify(probes));
      throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    console.log(`dry run OK (applied twice, rolled back): ${file}`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}
main().catch((e) => { console.error("FAIL", e.message ?? e); process.exit(1); });
