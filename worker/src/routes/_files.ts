/**
 * Helpers shared by routes/files.ts and routes/pages.ts. These lived in
 * backend/app/api/v1/files.py (pages.py imported them from there).
 *
 *   MIME_KIND, KIND_CAP_BYTES, GUEST_KIND_CAP_BYTES, KIND_SERVE_MODE, classify()
 *   ensureStorage()                      (_ensure_storage)
 *   canonicalUuid(v)                     (Python UUID(v) — lenient, null if invalid)
 *   storageKey(userId, fileId, filename) (_storage_key)
 *   serveHost(db, settings, userId, domainId)   (_serve_host)
 *   buildServeUrl(host, shortCode, filename)    (_build_serve_url)
 *   allocateUniqueShortCode(db, domainId)       (_allocate_unique_short_code)
 *   fileResponse(db, settings, asset)           (_to_response)
 *   authorizeAsset(asset, user, ownerToken)     (_authorize_asset)
 *   getOwnedFile(c, fileId, userId)             (_get_owned_file)
 *   deleteBlobQuiet(bucket, key)                (_delete_blob_quiet / _delete_storage_async)
 *   computeSha256Async(bucket, db, fileId, key) (_compute_sha256_async)
 *   dateRange(days, startDate, endDate)         (_file_date_range / pages._date_range)
 */
import { and, eq, isNotNull, isNull, ne, or } from "drizzle-orm";
import type { z } from "zod";
import { parseJson } from "../lib/validate";
import type { Db } from "../db/client";
import {
  DOMAIN_STATUS_ACTIVE,
  FILE_KIND_HTML,
  FILE_KIND_IMAGE,
  FILE_KIND_OTHER,
  FILE_KIND_PDF,
  FILE_KIND_VIDEO,
  FILE_STATUS_DELETED,
  SERVE_REDIRECT,
  SERVE_STREAM,
  domains,
  fileAssets,
} from "../db/schema";
import type { Ctx, Settings } from "../env";
import type { TokenData } from "../auth/security";
import { bytesToHex, sha256Hex, timingSafeEqual } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { deleteObject } from "../lib/storage";
import { isoUtc, parseIso } from "../lib/time";
import { allocateFileShortCode, safeSlug, schemeFor } from "../services/content";
import type { FileAsset } from "../services/assetLookup";

export type { FileAsset };

export const MB = 1024 * 1024;

// Caps are per-kind. Anything above the cap is rejected at intent time.
// Anything classified as 'video' or 'other' uses redirect-serve (when presigned
// R2 URLs are available) so GB-sized bodies don't stream through the Worker.
export const MIME_KIND: Record<string, string> = {
  "application/pdf": FILE_KIND_PDF,
  "text/html": FILE_KIND_HTML,
  "video/mp4": FILE_KIND_VIDEO,
  "video/webm": FILE_KIND_VIDEO,
  "image/png": FILE_KIND_IMAGE,
  "image/jpeg": FILE_KIND_IMAGE,
  "image/webp": FILE_KIND_IMAGE,
};

// Per-kind upload caps (authed users). Single source of truth — the Files and
// Generator upload UIs render their size hints from these same numbers. HTML
// is roomier than PDF/image because one-pagers inline their assets.
export const KIND_CAP_BYTES: Record<string, number> = {
  [FILE_KIND_PDF]: 50 * MB,
  [FILE_KIND_HTML]: 20 * MB,
  [FILE_KIND_IMAGE]: 10 * MB,
  [FILE_KIND_VIDEO]: 500 * MB,
  [FILE_KIND_OTHER]: 50 * MB,
};

// Tighter caps for anonymous (signed-out) uploads: bounds abuse on the shared
// platform-default namespace.
export const GUEST_KIND_CAP_BYTES: Record<string, number> = {
  [FILE_KIND_PDF]: 10 * MB,
  [FILE_KIND_HTML]: 10 * MB,
  [FILE_KIND_IMAGE]: 5 * MB,
  [FILE_KIND_VIDEO]: 50 * MB,
  [FILE_KIND_OTHER]: 10 * MB,
};

export const KIND_SERVE_MODE: Record<string, string> = {
  [FILE_KIND_PDF]: SERVE_STREAM,
  [FILE_KIND_HTML]: SERVE_STREAM,
  [FILE_KIND_IMAGE]: SERVE_STREAM,
  [FILE_KIND_VIDEO]: SERVE_REDIRECT,
  [FILE_KIND_OTHER]: SERVE_REDIRECT,
};

export function classify(contentType: string): string {
  return MIME_KIND[contentType.toLowerCase().split(";", 1)[0].trim()] ?? FILE_KIND_OTHER;
}

/** Storage is always configured on Cloudflare (R2 binding); kept for parity. */
export function ensureStorage(settings: Settings): void {
  if (!settings.storageConfigured) {
    httpError(
      503,
      "File storage is not configured on this deployment. Set STORAGE_BACKEND and its credentials " +
        "(local needs none; mongo needs MONGO_URL; s3 needs the SUPABASE_STORAGE_* vars), then redeploy.",
    );
  }
}

/** Python `UUID(value)`: accepts hyphenless/braced/urn forms; canonical lowercase or null. */
export function canonicalUuid(value: string | null | undefined): string | null {
  let v = (value ?? "").trim().toLowerCase();
  if (v.startsWith("urn:uuid:")) v = v.slice(9);
  v = v.replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(v)) return null;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

export function storageKey(userId: string | null | undefined, fileId: string, filename: string): string {
  // ASCII-safe slug; the original filename is preserved on the row.
  const safe = safeSlug(filename);
  return userId ? `u/${userId}/${fileId}/${safe}` : `anon/${fileId}/${safe}`;
}

function hostFromBaseUrl(settings: Settings): string {
  try {
    const u = new URL(settings.redirectBaseUrl);
    return u.host || "localhost:8000";
  } catch {
    return "localhost:8000";
  }
}

/**
 * Hostname for a file's serve URL: explicit domain_id -> user's primary active
 * domain -> platform default. Anonymous assets always use the platform host.
 */
export async function serveHost(
  db: Db,
  settings: Settings,
  userId: string | null | undefined,
  domainId: string | null | undefined,
): Promise<string> {
  if (userId) {
    if (domainId) {
      const d = await db
        .select({ hostname: domains.hostname })
        .from(domains)
        // asset.domain_id was authorized at write time; an org domain is not owned by the member.
        .where(and(eq(domains.id, domainId), eq(domains.status, DOMAIN_STATUS_ACTIVE), or(eq(domains.userId, userId), isNotNull(domains.organizationId))))
        .get();
      if (d) return d.hostname;
    }
    const primary = await db
      .select({ hostname: domains.hostname })
      .from(domains)
      .where(and(eq(domains.userId, userId), eq(domains.isPrimary, true), eq(domains.status, DOMAIN_STATUS_ACTIVE), isNull(domains.organizationId)))
      .get();
    if (primary) return primary.hostname;
  }
  return settings.resolvedShareHost || settings.resolvedPlatformRedirectHost || hostFromBaseUrl(settings);
}

export function buildServeUrl(host: string, shortCode: string, filename: string): string {
  // Slug is purely cosmetic; the handler routes on {code}.
  return `${schemeFor(host)}://${host}/f/${shortCode}/${safeSlug(filename)}`;
}

export const allocateUniqueShortCode = allocateFileShortCode;

/** tracking (no self-destruct) | expiring (controls set, still live) | expired. */
export function accessStatus(asset: FileAsset, now = Date.now()): string {
  const views = asset.viewCount ?? 0;
  const exp = parseIso(asset.expiresAt);
  const isExpired =
    asset.revokedAt != null || (exp !== null && exp.getTime() < now) || (asset.maxViews != null && views >= asset.maxViews);
  if (isExpired) return "expired";
  if (asset.expiresAt != null || asset.maxViews != null || asset.revokedAt != null) return "expiring";
  return "tracking";
}

/** "file" (Files, download) or "page" (Pages, hosted). Legacy rows: a slugged page is a page. */
export function outputKind(asset: Pick<FileAsset, "shareIntent" | "slug">): "file" | "page" {
  if (asset.shareIntent) return asset.shareIntent === "host" ? "page" : "file";
  return asset.slug ? "page" : "file";
}

/** SQL twin of outputKind=="page": every hosted kind (PDF, image, video, HTML), never download-intent. */
export const hostedCond = or(
  eq(fileAssets.shareIntent, "host"),
  and(isNull(fileAssets.shareIntent), eq(fileAssets.kind, FILE_KIND_HTML)),
);

/** https://<host>/<slug> for hosted shares (root-slug form); null when there is no root-slug address. */
export function publicUrl(host: string, asset: Pick<FileAsset, "kind" | "shareIntent" | "slug">): string | null {
  if (!asset.slug || (asset.shareIntent !== "host" && asset.kind !== FILE_KIND_HTML)) return null;
  return `${schemeFor(host)}://${host}/${asset.slug}`;
}

export async function fileResponse(db: Db, settings: Settings, asset: FileAsset) {
  const host = await serveHost(db, settings, asset.userId, asset.domainId);
  const views = asset.viewCount ?? 0;
  return {
    intent: asset.shareIntent ?? null,
    output_kind: outputKind(asset),
    slug: asset.slug ?? null,
    public_url: publicUrl(host, asset),
    id: asset.id,
    short_code: asset.shortCode,
    filename: asset.filename,
    kind: asset.kind,
    mime_type: asset.mimeType,
    size_bytes: asset.sizeBytes,
    status: asset.status,
    serve_mode: asset.serveMode,
    view_count: views,
    last_viewed_at: isoUtc(asset.lastViewedAt),
    created_at: isoUtc(asset.createdAt) ?? "",
    serve_url: buildServeUrl(host, asset.shortCode, asset.filename),
    domain_id: asset.domainId ?? null,
    expires_at: isoUtc(asset.expiresAt),
    project_id: asset.projectId ?? null,
    max_views: asset.maxViews ?? null,
    remaining_views: asset.maxViews != null ? Math.max(0, asset.maxViews - views) : null,
    require_email: !!asset.requireEmail,
    block_vpn: !!asset.blockVpn,
    branded: !!asset.branded,
    revoked: asset.revokedAt != null,
    access_status: accessStatus(asset),
  };
}

/** True if the caller owns the asset (authed user) or holds its owner token. */
export async function authorizeAsset(
  asset: FileAsset,
  user: TokenData | null,
  ownerToken: string | null | undefined,
): Promise<boolean> {
  if (user && asset.userId && asset.userId === user.userId) return true;
  if (ownerToken && asset.ownerTokenHash) {
    return timingSafeEqual(await sha256Hex(ownerToken), asset.ownerTokenHash);
  }
  return false;
}

export async function getFileRow(db: Db, fileId: string): Promise<FileAsset | undefined> {
  return db.select().from(fileAssets).where(eq(fileAssets.id, fileId)).get();
}

/** A non-deleted file owned by the user. 400 on a bad id, 404 otherwise. */
export async function getOwnedFile(c: Ctx, fileId: string, userId: string): Promise<FileAsset> {
  const fid = canonicalUuid(fileId);
  if (!fid) httpError(400, "Invalid file_id.");
  const asset = await c.var.db
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.id, fid), eq(fileAssets.userId, userId), ne(fileAssets.status, FILE_STATUS_DELETED)))
    .get();
  if (!asset) httpError(404, "File not found.");
  return asset;
}

/** Best-effort blob cleanup (background). */
export async function deleteBlobQuiet(bucket: R2Bucket, key: string): Promise<void> {
  try {
    await deleteObject(bucket, key);
  } catch (err) {
    console.error(`failed deleting blob ${key}`, err);
  }
}

/** Stream the object once to compute its SHA-256 and store it. Best-effort. */
export async function computeSha256Async(bucket: R2Bucket, db: Db, fileId: string, key: string): Promise<void> {
  try {
    const obj = await bucket.get(key);
    if (!obj) return;
    const digestStream = new crypto.DigestStream("SHA-256");
    await obj.body.pipeTo(digestStream);
    const digest = bytesToHex(await digestStream.digest);
    // Only if the asset still points at this blob (a replace may have raced).
    await db
      .update(fileAssets)
      .set({ sha256: digest })
      .where(and(eq(fileAssets.id, fileId), eq(fileAssets.storageKey, key)));
  } catch (err) {
    console.error(`sha256 background task failed for file_id=${fileId}`, err);
  }
}

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/** datetime.fromisoformat for the forms the SPA sends; null when invalid. Naive = UTC. */
function fromIsoFormat(s: string): Date | null {
  const m = ISO_DATE_RE.exec(s.trim());
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00", sec = "00", frac = "", tz] = m;
  const ms = frac ? Number(frac.padEnd(3, "0").slice(0, 3)) : 0;
  let t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec, ms);
  const check = new Date(Date.UTC(+y, +mo - 1, +d));
  if (check.getUTCMonth() !== +mo - 1 || check.getUTCDate() !== +d || +h > 23 || +mi > 59 || +sec > 59) return null;
  if (tz && tz !== "Z") {
    const sign = tz[0] === "-" ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    t -= sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2))) * 60_000;
  }
  return new Date(t);
}

/**
 * Analytics window: explicit start/end dates (end extended to 23:59:59), else
 * the last `days` days. Returns ISO strings comparable with stored timestamps.
 */
export function dateRange(days: number, startDate?: string | null, endDate?: string | null): [string, string] {
  const now = new Date();
  if (startDate && endDate) {
    const start = fromIsoFormat(startDate);
    const endRaw = fromIsoFormat(endDate);
    if (!start || !endRaw) httpError(400, "Invalid date format. Use ISO 8601 (YYYY-MM-DD).");
    const end = new Date(endRaw);
    end.setUTCHours(23, 59, 59);
    if (start.getTime() > end.getTime()) httpError(400, "start_date must be before end_date.");
    return [start.toISOString(), end.toISOString()];
  }
  return [new Date(now.getTime() - days * 86_400_000).toISOString(), now.toISOString()];
}

/**
 * Parse a JSON body (FastAPI 422 shapes via parseJson) and also return which
 * keys were actually sent — Pydantic's `model_fields_set`. With `optional`,
 * an empty body yields null (`body: Optional[Model] = None`).
 */
export async function parseBodyWithFields<S extends z.ZodType>(
  c: Ctx,
  schema: S,
  opts: { optional: true },
): Promise<{ data: z.infer<S>; fields: Set<string> } | null>;
export async function parseBodyWithFields<S extends z.ZodType>(
  c: Ctx,
  schema: S,
): Promise<{ data: z.infer<S>; fields: Set<string> }>;
export async function parseBodyWithFields<S extends z.ZodType>(
  c: Ctx,
  schema: S,
  opts: { optional?: boolean } = {},
): Promise<{ data: z.infer<S>; fields: Set<string> } | null> {
  const text = await c.req.text();
  if (opts.optional && !text.trim()) return null;
  const data = await parseJson(c, schema);
  let fields = new Set<string>();
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) fields = new Set(Object.keys(raw));
  } catch {
    // parseJson already rejected invalid JSON.
  }
  return { data, fields };
}
