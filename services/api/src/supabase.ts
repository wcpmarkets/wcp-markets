import { fetchSsm } from "./secrets.js";

/**
 * Server-side Supabase Storage helpers (service-role). The API is the ONLY thing
 * that touches Storage: it mints short-lived SIGNED upload/download URLs for the
 * private `listing-images` bucket so clients never hold the service key and never
 * talk to Storage directly. The key comes from SUPABASE_SECRET_KEY (local) or an
 * SSM SecureString named by SUPABASE_SECRET_KEY_SSM (Lambda), fetched once.
 */
let serviceKey: string | null | undefined; // undefined = not tried; null = none

async function getServiceKey(): Promise<string | null> {
  if (serviceKey !== undefined) return serviceKey;
  let key = process.env.SUPABASE_SECRET_KEY;
  const ssmName = process.env.SUPABASE_SECRET_KEY_SSM;
  if (!key && ssmName) key = await fetchSsm(ssmName);
  serviceKey = key ?? null;
  if (!serviceKey) console.warn("[supabase] no service key — Storage signing disabled.");
  return serviceKey;
}

function storageBase(): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error("SUPABASE_URL unset");
  return `${url}/storage/v1`;
}

/** Mint a signed UPLOAD URL (already carries its one-shot token). null if unconfigured. */
export async function createSignedUploadUrl(
  bucket: string,
  path: string,
): Promise<{ uploadUrl: string; path: string } | null> {
  const key = await getServiceKey();
  if (!key) return null;
  const res = await fetch(`${storageBase()}/object/upload/sign/${bucket}/${path}`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    console.error("[supabase] sign upload failed", res.status, await res.text());
    return null;
  }
  const body = (await res.json()) as { url: string };
  return { uploadUrl: `${storageBase()}${body.url}`, path };
}

/** Mint a signed DOWNLOAD URL for a private object. null if unconfigured/absent. */
export async function createSignedDownloadUrl(
  bucket: string,
  path: string,
  expiresIn = 3600,
): Promise<string | null> {
  const key = await getServiceKey();
  if (!key) return null;
  const res = await fetch(`${storageBase()}/object/sign/${bucket}/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) {
    console.error("[supabase] sign download failed", res.status, await res.text());
    return null;
  }
  const body = (await res.json()) as { signedURL: string };
  return `${storageBase()}${body.signedURL}`;
}

/** Delete a private object (best-effort — used to clean up orphaned KYC selfies). */
export async function deleteStorageObject(bucket: string, path: string): Promise<void> {
  const key = await getServiceKey();
  if (!key) return;
  try {
    await fetch(`${storageBase()}/object/${bucket}/${path}`, {
      method: "DELETE",
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
  } catch (e) {
    console.error("[supabase] delete object failed", e);
  }
}

export const LISTING_IMAGES_BUCKET = "listing-images";
