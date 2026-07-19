import postgres from "postgres";

/**
 * Lazy Postgres client for the Supabase database.
 *
 * The connection string comes from either `DATABASE_URL` (local dev, from
 * .env) or — on Lambda — an SSM SecureString named by `DATABASE_URL_SSM`,
 * fetched at runtime with decryption. The secret therefore never lives in the
 * Lambda env config, Terraform state, or git.
 *
 * Uses the Supabase **Supavisor transaction-mode pooler** (:6543), so
 * `prepare: false` is REQUIRED (transaction pooling can't keep prepared
 * statements across a warm Lambda). Returns `null` when no connection string is
 * available so handlers degrade gracefully.
 */
let client: postgres.Sql | null = null;
let pending: Promise<postgres.Sql | null> | null = null;

export function getDb(): Promise<postgres.Sql | null> {
  if (client) return Promise.resolve(client);
  // Cache only a successful connection; if none yet, allow a later retry (e.g.
  // the SSM parameter is created after the first cold start).
  if (!pending) {
    pending = init()
      .then((c) => {
        client = c;
        return c;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

async function init(): Promise<postgres.Sql | null> {
  let url = process.env.DATABASE_URL;
  const ssmName = process.env.DATABASE_URL_SSM;
  if (!url && ssmName) url = await fetchSsm(ssmName);

  if (!url) {
    console.warn("[db] no DATABASE_URL — running without a database.");
    return null;
  }
  return postgres(url, {
    prepare: false, // Supavisor transaction mode
    max: 3, // small pool per warm Lambda
    idle_timeout: 20,
    connect_timeout: 10,
  });
}

async function fetchSsm(name: string): Promise<string | undefined> {
  try {
    // Resolved from the Lambda runtime's bundled AWS SDK v3 (externalized in the
    // build). Never called locally, where DATABASE_URL is set directly.
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({});
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return res.Parameter?.Value;
  } catch (e) {
    console.error(`[db] failed to fetch DATABASE_URL from SSM (${name}):`, e);
    return undefined;
  }
}
