/**
 * R2 object storage. Port of backend/app/services/storage.py with the same
 * public surface, so call sites translate 1:1:
 *
 *   prepareUpload, generatePresignedGet, headObject, deleteObject,
 *   getObject (replaces stream_object; supports Range), writeStream,
 *   putBytes, makeBlobToken / verifyBlobToken, backendIsS3
 *
 * Two upload paths, chosen automatically:
 *  - R2 S3 credentials set (R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY)
 *    -> presigned PUT straight to R2 (Python "s3" backend behaviour; no size
 *       limit from the Worker). Requires a CORS rule on the bucket.
 *  - otherwise -> the browser PUTs to /api/v1/files/{id}/blob?token=... and the
 *    Worker streams the body into the FILES binding (Python "local" backend
 *    behaviour). Capped by the plan's request-body limit (100 MB Free/Pro).
 */
import { AwsClient } from "aws4fetch";
import type { Settings } from "../env";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

export class StorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageError";
  }
}
export class StorageNotConfigured extends StorageError {}
export class StorageFileTooLarge extends StorageError {}

export const BLOB_TOKEN_TTL = 600; // seconds

export async function makeBlobToken(settings: Settings, fileId: string, ttl = BLOB_TOKEN_TTL): Promise<string> {
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const sig = await hmacSha256Hex(settings.resolvedUploadSecret, `${fileId}:${expiresAt}`);
  return `${expiresAt}.${sig}`;
}

export async function verifyBlobToken(settings: Settings, fileId: string, token: string | null | undefined): Promise<boolean> {
  if (!token) return false;
  const idx = token.indexOf(".");
  if (idx < 0) return false;
  const expiresAt = Number.parseInt(token.slice(0, idx), 10);
  const sig = token.slice(idx + 1);
  if (!Number.isFinite(expiresAt) || expiresAt < Math.floor(Date.now() / 1000)) return false;
  const expected = await hmacSha256Hex(settings.resolvedUploadSecret, `${fileId}:${expiresAt}`);
  return timingSafeEqual(sig, expected);
}

/** True when presigned (direct-to-R2) URLs are available — the Python `backend_is_s3()`. */
export function backendIsS3(settings: Settings): boolean {
  return settings.r2PresignConfigured;
}

function aws(settings: Settings): AwsClient {
  if (!settings.r2PresignConfigured) {
    throw new StorageNotConfigured(
      "R2 presigned URLs are not configured (set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).",
    );
  }
  return new AwsClient({
    accessKeyId: settings.r2AccessKeyId,
    secretAccessKey: settings.r2SecretAccessKey,
    service: "s3",
    region: "auto",
  });
}

function objectUrl(settings: Settings, key: string): URL {
  const path = key.split("/").map(encodeURIComponent).join("/");
  return new URL(`https://${settings.r2AccountId}.r2.cloudflarestorage.com/${settings.r2BucketName}/${path}`);
}

export interface PreparedUpload {
  url: string;
  headers: Record<string, string>;
  via_backend: boolean;
}

export async function prepareUpload(
  settings: Settings,
  opts: { fileId: string; key: string; contentType: string; sizeBytes: number },
): Promise<PreparedUpload> {
  if (backendIsS3(settings)) {
    const url = objectUrl(settings, opts.key);
    url.searchParams.set("X-Amz-Expires", String(BLOB_TOKEN_TTL));
    const signed = await aws(settings).sign(
      new Request(url, { method: "PUT", headers: { "Content-Type": opts.contentType } }),
      { aws: { signQuery: true } },
    );
    // The browser PUTs directly to R2; the Clerk Authorization header must NOT be sent there.
    return { url: signed.url, headers: { "Content-Type": opts.contentType }, via_backend: false };
  }
  const token = await makeBlobToken(settings, opts.fileId);
  return {
    // Absolute API path; the frontend prepends its API origin (frontend/src/api/files.ts).
    url: `${settings.apiV1Prefix}/files/${opts.fileId}/blob?token=${token}`,
    headers: { "Content-Type": opts.contentType },
    via_backend: true,
  };
}

/** Presigned GET (redirect serving). Throws StorageError when presigning is unavailable. */
export async function generatePresignedGet(
  settings: Settings,
  key: string,
  filename?: string | null,
  expires = 300,
): Promise<string> {
  if (!backendIsS3(settings)) {
    throw new StorageError("R2 binding serves files by streaming, not redirect.");
  }
  const url = objectUrl(settings, key);
  url.searchParams.set("X-Amz-Expires", String(expires));
  if (filename) {
    const safe = filename.replace(/"/g, "").replace(/\n/g, " ");
    url.searchParams.set("response-content-disposition", `inline; filename="${safe}"`);
  }
  const signed = await aws(settings).sign(new Request(url, { method: "GET" }), { aws: { signQuery: true } });
  return signed.url;
}

export async function headObject(
  bucket: R2Bucket,
  key: string,
): Promise<{ size: number; etag: string | null; content_type: string | null }> {
  const obj = await bucket.head(key);
  if (!obj) throw new StorageError(`Object not found: ${key}`);
  return { size: obj.size, etag: obj.etag ?? null, content_type: obj.httpMetadata?.contentType ?? null };
}

export async function deleteObject(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/**
 * Fetch an object for streaming. Pass the request's Range header through to
 * support video seeking. Throws StorageError when missing.
 */
export async function getObject(
  bucket: R2Bucket,
  key: string,
  opts: { range?: R2Range | Headers } = {},
): Promise<R2ObjectBody> {
  const obj = await bucket.get(key, opts.range ? { range: opts.range } : undefined);
  if (!obj || !("body" in obj)) throw new StorageError(`Object not found: ${key}`);
  return obj as R2ObjectBody;
}

export async function putBytes(
  bucket: R2Bucket,
  key: string,
  data: ArrayBuffer | Uint8Array | string,
  contentType?: string,
): Promise<number> {
  const obj = await bucket.put(key, data, contentType ? { httpMetadata: { contentType } } : undefined);
  return obj?.size ?? 0;
}

/**
 * Stream a request body into R2, enforcing `maxBytes` (Python `write_stream`).
 * R2 needs a known length for streamed puts: with a Content-Length we stream
 * through a FixedLengthStream; without one we buffer up to maxBytes.
 * Returns bytes written; throws StorageFileTooLarge when over the cap.
 */
export async function writeStream(
  bucket: R2Bucket,
  opts: {
    key: string;
    body: ReadableStream<Uint8Array> | null;
    contentLength?: number | null;
    maxBytes: number;
    contentType?: string;
  },
): Promise<number> {
  const tooLarge = () => new StorageFileTooLarge(`Upload exceeds the allowed size (${opts.maxBytes} bytes).`);
  const httpMetadata = opts.contentType ? { contentType: opts.contentType } : undefined;
  if (!opts.body) {
    await bucket.put(opts.key, new Uint8Array(0), { httpMetadata });
    return 0;
  }
  const len = opts.contentLength;
  if (len != null && Number.isFinite(len) && len >= 0) {
    if (len > opts.maxBytes) throw tooLarge();
    const fixed = new FixedLengthStream(len);
    const [, putResult] = await Promise.all([
      opts.body.pipeTo(fixed.writable),
      bucket.put(opts.key, fixed.readable, { httpMetadata }),
    ]);
    return putResult?.size ?? len;
  }
  const reader = opts.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.length) continue;
    total += value.length;
    if (total > opts.maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    parts.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    buf.set(p, off);
    off += p.length;
  }
  await bucket.put(opts.key, buf, { httpMetadata });
  return total;
}
