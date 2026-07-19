import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, openApiDocument } from "../src/app.js";

// Emit the OpenAPI 3.1 document to the committed contract artifact.
// Clients (TS now, Swift/Kotlin later) generate from this file, NOT live code —
// CI diffs it so the published contract can't drift silently.
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../contracts/openapi.json");

const doc = openApiDocument(createApp());
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(doc, null, 2) + "\n", "utf8");

// eslint-disable-next-line no-console
console.log(`[contract] wrote ${out}`);
