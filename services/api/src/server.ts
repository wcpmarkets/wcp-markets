import { serve } from "@hono/node-server";
import { createApp } from "./app.js";

// Local dev entry — runs the same app that will deploy to Lambda.
const app = createApp();

// Serve the live OpenAPI doc for quick inspection during dev.
app.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: { title: "WCP Markets API", version: "0.0.1" },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[api] listening on http://localhost:${info.port}`);
});
