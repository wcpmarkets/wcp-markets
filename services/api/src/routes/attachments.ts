import { randomUUID } from "node:crypto";
import { type OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { auth, type AuthEnv } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rate-limit.js";
import { ATTACHMENTS_BUCKET, createSignedDownloadUrls, createSignedUploadUrl } from "../supabase.js";

/**
 * Photos people attach to things that aren't listings: a buyer's quote request
 * ("here's the leak"), a host's deposit claim, a dispute. Same two-step upload as
 * avatars and listing photos — mint a signed URL here, PUT the bytes to Storage —
 * into a PRIVATE bucket, under the uploader's own folder. The thing they're attached
 * to stores the paths; reads hand back short-lived signed URLs.
 *
 * A path is only accepted back from the user whose folder it is (ownedPaths), so
 * nobody can attach — and so get signed URLs for — someone else's upload.
 */
const ErrorSchema = z.object({ error: z.string() }).openapi("Error");

const IMAGE_TYPES = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" } as const;

const AttachmentUploadRequestSchema = z
  .object({ contentType: z.enum(["image/jpeg", "image/png", "image/webp"]) })
  .openapi("AttachmentUploadRequest");

const AttachmentUploadSchema = z
  .object({
    /** Pass this back in `photoPaths` on the request/claim/dispute it belongs to. */
    path: z.string(),
    /** PUT the image bytes here (expires in 2h). */
    uploadUrl: z.string().url(),
  })
  .openapi("AttachmentUpload");

/** At most this many photos on one request/claim/dispute. */
export const MAX_PHOTOS = 4;

/** The `photoPaths` field: paths minted by POST /attachments. */
export const PhotoPathsSchema = z.array(z.string().max(200)).max(MAX_PHOTOS);

const PATH_RE = /^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/** The paths if every one is the caller's own upload, else null (→ 422 bad_photo). */
export function ownedPaths(userId: string, paths: readonly string[] | undefined): string[] | null {
  const out = [...new Set(paths ?? [])];
  return out.every((p) => PATH_RE.test(p) && p.startsWith(`${userId}/`)) ? out : null;
}

/** Signed download URLs for stored paths (dropping any that no longer exist). */
export async function photoUrls(paths: readonly string[] | null | undefined): Promise<string[]> {
  if (!paths?.length) return [];
  return (await createSignedDownloadUrls(ATTACHMENTS_BUCKET, paths)).filter((u): u is string => u != null);
}

export function registerAttachments(app: OpenAPIHono<AuthEnv>) {
  app.openapi(
    createRoute({
      method: "post",
      path: "/attachments",
      summary: "Get a signed upload URL for a photo to attach to a request, claim or dispute",
      tags: ["attachments"],
      security: [{ bearerAuth: [] }],
      middleware: [
        auth,
        rateLimit({ prefix: "attach", limit: 40, windowSecs: 3600, keys: (c) => [(c.get("user") as { sub: string }).sub] }),
      ] as const,
      request: { body: { content: { "application/json": { schema: AttachmentUploadRequestSchema } } } },
      responses: {
        200: { description: "PUT the bytes to uploadUrl", content: { "application/json": { schema: AttachmentUploadSchema } } },
        401: { description: "Unauthorized" },
        429: { description: "Too many uploads", content: { "application/json": { schema: ErrorSchema } } },
        503: { description: "Storage unavailable", content: { "application/json": { schema: ErrorSchema } } },
      },
    }),
    async (c) => {
      const user = c.get("user");
      const { contentType } = c.req.valid("json");
      const path = `${user.sub}/${randomUUID()}.${IMAGE_TYPES[contentType]}`;
      const signed = await createSignedUploadUrl(ATTACHMENTS_BUCKET, path);
      if (!signed) return c.json({ error: "storage_unavailable" }, 503);
      return c.json({ path, uploadUrl: signed.uploadUrl }, 200);
    },
  );
}
