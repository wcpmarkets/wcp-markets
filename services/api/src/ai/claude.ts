/**
 * Phase 3I — the Anthropic client, for AI search. The key lives in SSM
 * (`/wcp/api/anthropic-api-key`, SecureString), like every other secret; locally,
 * ANTHROPIC_API_KEY. It is read at cold start and, while missing, re-checked every 5
 * minutes — so adding it needs no redeploy and reaches warm instances too.
 *
 * No key → `claude()` is null and search runs on the keyword interpreter (rules.ts).
 * That is a supported mode, not an error: the app works, just less cleverly.
 */
import Anthropic from "@anthropic-ai/sdk";
import { fetchSsm } from "../secrets.js";

let client: Anthropic | null | undefined;
let loading: Promise<Anthropic | null> | null = null;
/** When a missing key was last looked for; a null client is only trusted this long. */
let missingSince = 0;
const RECHECK_MS = 5 * 60_000;

/**
 * Overridable so the cost/quality trade can be changed without a code change
 * (e.g. SEARCH_AI_MODEL=claude-haiku-5-5). Default: Claude Opus 5.5 at low effort.
 */
export const SEARCH_MODEL = process.env.SEARCH_AI_MODEL ?? "claude-opus-5-5";

export async function claude(): Promise<Anthropic | null> {
  if (client) return client;
  if (client === null && Date.now() - missingSince < RECHECK_MS) return null;
  loading ??= (async () => {
    let key = process.env.ANTHROPIC_API_KEY;
    if (!key && process.env.ANTHROPIC_API_KEY_SSM) key = await fetchSsm(process.env.ANTHROPIC_API_KEY_SSM);
    // Search is interactive: no SDK retries (we fall back to rules instead), and a
    // timeout that leaves room inside the Lambda's 15s for the DB work around it.
    client = key ? new Anthropic({ apiKey: key, timeout: 9_000, maxRetries: 0 }) : null;
    if (!client) missingSince = Date.now();
    return client;
  })().finally(() => {
    loading = null;
  });
  return loading;
}
