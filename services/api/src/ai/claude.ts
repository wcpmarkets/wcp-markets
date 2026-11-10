/**
 * Phase 3I — the Anthropic client, for AI search. The key lives in SSM
 * (`/wcp/api/anthropic-api-key`, SecureString), like every other secret; locally,
 * ANTHROPIC_API_KEY. It is read once per cold start, so adding it needs no redeploy.
 *
 * No key → `claude()` is null and search runs on the keyword interpreter (rules.ts).
 * That is a supported mode, not an error: the app works, just less cleverly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { fetchSsm } from "../secrets.js";

let client: Anthropic | null | undefined;
let loading: Promise<Anthropic | null> | null = null;

/**
 * Overridable so the cost/quality trade can be changed without a code change
 * (e.g. SEARCH_AI_MODEL=claude-haiku-5-5). Default: Claude Opus 5.5 at low effort.
 */
export const SEARCH_MODEL = process.env.SEARCH_AI_MODEL ?? "claude-opus-5-5";

export async function claude(): Promise<Anthropic | null> {
  if (client !== undefined) return client;
  loading ??= (async () => {
    let key = process.env.ANTHROPIC_API_KEY;
    if (!key && process.env.ANTHROPIC_API_KEY_SSM) key = await fetchSsm(process.env.ANTHROPIC_API_KEY_SSM);
    // Search is interactive: no SDK retries (we fall back to rules instead), and a
    // timeout that leaves room inside the Lambda's 15s for the DB work around it.
    client = key ? new Anthropic({ apiKey: key, timeout: 9_000, maxRetries: 0 }) : null;
    return client;
  })();
  return loading;
}
