/**
 * Fetch + decrypt a single SSM SecureString at Lambda runtime. The AWS SDK is
 * resolved from the Lambda runtime (externalized in the esbuild bundle) and is
 * never used locally, where secrets come straight from the environment.
 * Returns undefined on any error so callers can degrade gracefully.
 */
export async function fetchSsm(name: string): Promise<string | undefined> {
  try {
    const { SSMClient, GetParameterCommand } = await import("@aws-sdk/client-ssm");
    const ssm = new SSMClient({});
    const res = await ssm.send(
      new GetParameterCommand({ Name: name, WithDecryption: true }),
    );
    return res.Parameter?.Value;
  } catch (e) {
    console.error(`[secrets] failed to fetch SSM param ${name}:`, e);
    return undefined;
  }
}
