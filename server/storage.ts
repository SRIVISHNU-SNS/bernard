// Storage adapter for Bernard.
// Uses Manus Forge when available and falls back to an in-process object store
// for portable deployments such as Render and Railway.

import { ENV } from "./_core/env";

type StoredObject = {
  data: Buffer;
  contentType: string;
};

const portableObjects = new Map<string, StoredObject>();

export function isPortableStorage() {
  return !ENV.forgeApiUrl || !ENV.forgeApiKey;
}

function getForgeConfig() {
  const forgeUrl = ENV.forgeApiUrl;
  const forgeKey = ENV.forgeApiKey;

  if (!forgeUrl || !forgeKey) return null;
  return { forgeUrl: forgeUrl.replace(/\/+$/, ""), forgeKey };
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
}

function appendHashSuffix(relKey: string): string {
  const hash = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const lastDot = relKey.lastIndexOf(".");
  if (lastDot === -1) return `${relKey}_${hash}`;
  return `${relKey.slice(0, lastDot)}_${hash}${relKey.slice(lastDot)}`;
}

function asBuffer(data: Buffer | Uint8Array | string) {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function asDataUrl(object: StoredObject) {
  return `data:${object.contentType};base64,${object.data.toString("base64")}`;
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream",
): Promise<{ key: string; url: string }> {
  const key = appendHashSuffix(normalizeKey(relKey));
  const forge = getForgeConfig();

  if (!forge) {
    portableObjects.set(key, { data: asBuffer(data), contentType });
    return { key, url: `/portable-storage/${key}` };
  }

  const { forgeUrl, forgeKey } = forge;
  const buffer = asBuffer(data);
  const presignUrl = new URL("v1/storage/presign/put", forgeUrl + "/");
  presignUrl.searchParams.set("path", key);

  const presignResp = await fetch(presignUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` },
  });

  if (!presignResp.ok) {
    const msg = await presignResp.text().catch(() => presignResp.statusText);
    throw new Error(`Storage presign failed (${presignResp.status}): ${msg}`);
  }

  const { url: s3Url } = (await presignResp.json()) as { url: string };
  if (!s3Url) throw new Error("Forge returned empty presign URL");

  const uploadResp = await fetch(s3Url, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Blob([buffer as unknown as ArrayBuffer], { type: contentType }),
  });

  if (!uploadResp.ok) {
    throw new Error(`Storage upload to S3 failed (${uploadResp.status})`);
  }

  return { key, url: `/manus-storage/${key}` };
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string }> {
  const key = normalizeKey(relKey);
  return { key, url: isPortableStorage() ? `/portable-storage/${key}` : `/manus-storage/${key}` };
}

export async function storageGetSignedUrl(relKey: string): Promise<string> {
  const key = normalizeKey(relKey);
  const forge = getForgeConfig();

  if (!forge) {
    const object = portableObjects.get(key);
    if (!object) throw new Error("Evidence is no longer available. Please upload it again.");
    return asDataUrl(object);
  }

  const { forgeUrl, forgeKey } = forge;
  const getUrl = new URL("v1/storage/presign/get", forgeUrl + "/");
  getUrl.searchParams.set("path", key);

  const resp = await fetch(getUrl, {
    headers: { Authorization: `Bearer ${forgeKey}` },
  });

  if (!resp.ok) {
    const msg = await resp.text().catch(() => resp.statusText);
    throw new Error(`Storage signed URL failed (${resp.status}): ${msg}`);
  }

  const { url } = (await resp.json()) as { url: string };
  if (!url) throw new Error("Storage returned an empty signed URL");
  return url;
}

export function getPortableObject(key: string) {
  return portableObjects.get(normalizeKey(key));
}
