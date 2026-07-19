import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";

// AWS Lambda entry point (Function URL / API Gateway v2 payload). Same app that
// runs locally via server.ts — the deploy target just wraps it.
export const handler = handle(createApp());
