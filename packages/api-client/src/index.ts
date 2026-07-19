import createClient, { type ClientOptions } from "openapi-fetch";
import type { paths } from "./schema.js";

/**
 * Typed WCP API client, generated from the committed OpenAPI contract
 * (`contracts/openapi.json` → `src/schema.ts` via `pnpm gen`). The web tester and
 * later the web app import this; each caller supplies its own transport config
 * (base URL, auth-token header) — the SDK gives the typed surface.
 */
export type WcpClientOptions = ClientOptions & {
  /** Called per request to supply the current Supabase access token, if any. */
  getAccessToken?: () => string | null | undefined | Promise<string | null | undefined>;
};

export function createWcpClient(options: WcpClientOptions = {}) {
  const { getAccessToken, ...rest } = options;
  const client = createClient<paths>(rest);

  if (getAccessToken) {
    client.use({
      async onRequest({ request }) {
        const token = await getAccessToken();
        if (token) request.headers.set("Authorization", `Bearer ${token}`);
        return request;
      },
    });
  }

  return client;
}

export type WcpClient = ReturnType<typeof createWcpClient>;
export type { paths } from "./schema.js";
