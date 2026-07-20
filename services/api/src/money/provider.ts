import { MockEscrowProvider } from "@wcp/escrow";
import { fetchSsm } from "../secrets.js";

/**
 * The escrow provider singleton (Mock for now). Both the webhook endpoint (verify +
 * parse) and the consumer Lambda (createHold/refund + buildWebhook) resolve it here.
 * Secret from ESCROW_WEBHOOK_SECRET (local) or SSM ESCROW_WEBHOOK_SECRET_SSM (Lambda).
 * Swap MockEscrowProvider for the real partner later behind the same interface.
 */
let provider: MockEscrowProvider | null | undefined;

export async function getEscrowProvider(): Promise<MockEscrowProvider | null> {
  if (provider !== undefined) return provider;
  let secret = process.env.ESCROW_WEBHOOK_SECRET;
  const ssm = process.env.ESCROW_WEBHOOK_SECRET_SSM;
  if (!secret && ssm) secret = await fetchSsm(ssm);
  provider = secret ? new MockEscrowProvider(secret) : null;
  if (!provider) console.warn("[escrow] no webhook secret — escrow disabled.");
  return provider;
}
