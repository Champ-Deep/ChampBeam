/**
 * Port of backend/app/api/v1/files.py — mounted at /api/v1/files.
 *
 * File hosting: upload + manage assets served on /f/{code} (the public serve
 * routes live in routes/filesServe.ts).
 *
 * Upload flow: POST /files (intent) -> browser PUTs the bytes to the returned
 * target (presigned R2 URL, or this Worker's /{id}/blob endpoint when no R2 S3
 * credentials are configured) -> POST /{id}/finalize -> GET /{id}/status.
 */
import { Hono } from "hono";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { getCurrentUser, requireAuth } from "../auth/security";
import { findUsableDomain, shareOrgUuid } from "../services/domains";
import {
  FILE_STATUS_ACTIVE,
  FILE_STATUS_DELETED,
  FILE_STATUS_FAILED,
  FILE_STATUS_PENDING_UPLOAD,
  SERVE_STREAM,
  accessLeads,
  clickEvents,
  domains,
  DOMAIN_STATUS_ACTIVE,
  fileAssets,
  pageEngagements,
  projects,
} from "../db/schema";
import { sha256Hex, tokenUrlsafe } from "../lib/crypto";
import { HTTPError, httpError } from "../lib/errors";
import { background } from "../lib/background";
import {
  StorageError,
  StorageFileTooLarge,
  StorageNotConfigured,
  backendIsS3,
  headObject,
  prepareUpload,
  verifyBlobToken,
  writeStream,
} from "../lib/storage";
import { isoUtc, nowIso, secondsFromNow } from "../lib/time";
import { parseQuery, qInt, qStr } from "../lib/validate";
import {
  GUEST_KIND_CAP_BYTES,
  KIND_CAP_BYTES,
  KIND_SERVE_MODE,
  MB,
  allocateUniqueShortCode,
  authorizeAsset,
  canonicalUuid,
  classify,
  computeSha256Async,
  dateRange,
  deleteBlobQuiet,
  ensureStorage,
  fileResponse,
  getFileRow,
  getOwnedFile,
  parseBodyWithFields,
  storageKey,
} from "./_files";

export const router = new Hono<AppEnv>({ strict: false });

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const FileInit = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127),
  size_bytes: z.number().int().min(1),
  domain_id: z.string().nullable().optional(),
  /** What the sender chose: "download" (attachment) or "host" (inline viewer). Omitted = legacy behaviour. */
  intent: z.enum(["download", "host"]).nullable().optional(),
});

const FileFinalizeRequest = z.object({ owner_token: z.string().nullable().optional() });

const FileUpdateRequest = z.object({ project_id: z.string().nullable().optional() });

const FileAccessRequest = z.object({
  expires_in_hours: z.number().int().nullable().optional(),
  max_views: z.number().int().nullable().optional(),
  require_email: z.boolean().nullable().optional(),
  block_vpn: z.boolean().nullable().optional(),
  branded: z.boolean().nullable().optional(),
  revoked: z.boolean().nullable().optional(),
});

const AnalyticsQuery = z.object({
  days: qInt(30, { ge: 1, le: 365 }),
  start_date: qStr(),
  end_date: qStr(),
});

function parseFileId(raw: string): string {
  const fid = canonicalUuid(raw);
  if (!fid) httpError(400, "Invalid file_id.");
  return fid;
}

async function userStorageUsed(c: Ctx, userId: string): Promise<number> {
  const row = await c.var.db
    .select({ used: sql<number>`coalesce(sum(${fileAssets.sizeBytes}), 0)` })
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.userId, userId),
        inArray(fileAssets.status, [FILE_STATUS_PENDING_UPLOAD, FILE_STATUS_ACTIVE]),
      ),
    )
    .get();
  return Number(row?.used ?? 0);
}

function serveModeFor(c: Ctx, kind: string): string {
  // Redirect serving needs presigned R2 GETs; without them everything streams.
  return backendIsS3(c.var.settings) ? KIND_SERVE_MODE[kind] : SERVE_STREAM;
}

// ---------------------------------------------------------------------------
// Upload: intent -> blob -> finalize -> status
// ---------------------------------------------------------------------------

/**
 * Begin an upload: validate, allocate a short_code, return an upload target.
 * Works signed-out: a guest upload gets a tighter size cap, an auto-expiry and
 * an owner_token so the uploader can later check whether it has been opened.
 */
router.post("/", async (c) => {
  const user = await getCurrentUser(c);
  const { data } = await parseBodyWithFields(c, FileInit);
  const settings = c.var.settings;
  const db = c.var.db;
  ensureStorage(settings);
  const isGuest = user === null;

  // Any content type is accepted; unknown ones are KIND_OTHER (safe download).
  const kind = classify(data.content_type);
  const cap = (isGuest ? GUEST_KIND_CAP_BYTES : KIND_CAP_BYTES)[kind];
  if (data.size_bytes > cap) {
    httpError(413, `${kind.toUpperCase()} uploads are capped at ${Math.floor(cap / MB)} MB.`);
  }

  let domainId: string | null = null;
  if (isGuest) {
    // Guests share the platform-default namespace; custom domains need auth.
    if (data.domain_id) httpError(400, "Custom domains require an account.");
  } else {
    const used = await userStorageUsed(c, user.userId);
    if (used + data.size_bytes > settings.maxBytesPerUser) {
      httpError(
        402,
        `Storage quota exceeded (${Math.floor(used / MB)} MB used of ${Math.floor(settings.maxBytesPerUser / MB)} MB).`,
      );
    }
    if (data.domain_id) {
      domainId = canonicalUuid(data.domain_id);
      if (!domainId) httpError(400, "Invalid domain_id.");
      const d = await findUsableDomain(db, user.userId, shareOrgUuid(user), domainId);
      if (!d) httpError(400, "Domain not found, not yours, or not active.");
    }
  }

  // Worker-proxied uploads are bounded by the plan's request-body limit.
  if (!backendIsS3(settings) && data.size_bytes > settings.workerUploadMaxBytes) {
    httpError(413, `Uploads are capped at ${Math.floor(settings.workerUploadMaxBytes / MB)} MB on this deployment.`);
  }

  const shortCode = await allocateUniqueShortCode(db, domainId);
  const fileId = crypto.randomUUID();
  const ownerUserId = user ? user.userId : null;
  const key = storageKey(ownerUserId, fileId, data.filename);
  const serveMode = serveModeFor(c, kind);

  let upload;
  try {
    upload = await prepareUpload(settings, {
      fileId,
      key,
      contentType: data.content_type,
      sizeBytes: data.size_bytes,
    });
  } catch (err) {
    if (err instanceof StorageNotConfigured) httpError(503, "File storage is not configured.");
    if (err instanceof StorageError) httpError(502, `Storage error: ${err.message}`);
    throw err;
  }

  let expiresAt: string | null = null;
  let ownerTokenRaw: string | null = null;
  let ownerTokenHash: string | null = null;
  if (isGuest) {
    expiresAt = secondsFromNow(settings.anonFileTtlSeconds);
    ownerTokenRaw = tokenUrlsafe(32);
    ownerTokenHash = await sha256Hex(ownerTokenRaw);
  }

  await db.insert(fileAssets).values({
    id: fileId,
    userId: ownerUserId,
    domainId,
    organizationId: user ? shareOrgUuid(user) : null,
    shareIntent: user ? (data.intent ?? null) : null,
    shortCode,
    filename: data.filename,
    kind,
    mimeType: data.content_type,
    sizeBytes: data.size_bytes,
    storageKey: key,
    status: FILE_STATUS_PENDING_UPLOAD,
    serveMode,
    viewCount: 0,
    createdAt: nowIso(),
    expiresAt,
    ownerTokenHash,
  });

  return c.json(
    {
      file_id: fileId,
      short_code: shortCode,
      presigned_put_url: upload.url,
      headers: upload.headers,
      serve_mode: serveMode,
      owner_token: ownerTokenRaw,
      expires_at: isoUtc(expiresAt),
      upload_via_backend: !!upload.via_backend,
    },
    201,
  );
});

/**
 * Verify the bytes landed in storage and flip the asset to active. Callable by
 * the owning user OR an anonymous uploader presenting the owner_token.
 */
router.post("/:file_id/finalize", async (c) => {
  const settings = c.var.settings;
  const db = c.var.db;
  const user = await getCurrentUser(c);
  const body = await parseBodyWithFields(c, FileFinalizeRequest, { optional: true });
  ensureStorage(settings);
  const fid = parseFileId(c.req.param("file_id"));

  const asset = await getFileRow(db, fid);
  if (!asset || !(await authorizeAsset(asset, user, body?.data.owner_token))) httpError(404, "File not found.");

  if (asset.status === FILE_STATUS_ACTIVE) return c.json(await fileResponse(db, settings, asset));
  if (asset.status !== FILE_STATUS_PENDING_UPLOAD && asset.status !== FILE_STATUS_FAILED) {
    httpError(409, `Cannot finalize from status '${asset.status}'.`);
  }

  const markFailed = () => db.update(fileAssets).set({ status: FILE_STATUS_FAILED }).where(eq(fileAssets.id, asset.id));
  let head;
  try {
    head = await headObject(c.env.FILES, asset.storageKey);
  } catch (err) {
    if (err instanceof StorageNotConfigured) httpError(503, "File storage is not configured.");
    await markFailed();
    httpError(400, `Upload not found in storage. The PUT may have failed: ${(err as Error).message}`);
  }

  const actualSize = Number(head.size || 0);
  if (actualSize !== asset.sizeBytes) {
    await markFailed();
    httpError(400, `Uploaded size (${actualSize} B) does not match the declared size (${asset.sizeBytes} B).`);
  }

  await db.update(fileAssets).set({ status: FILE_STATUS_ACTIVE }).where(eq(fileAssets.id, asset.id));
  asset.status = FILE_STATUS_ACTIVE;
  background(c, () => computeSha256Async(c.env.FILES, db, asset.id, asset.storageKey), "sha256");
  return c.json(await fileResponse(db, settings, asset));
});

/**
 * Receive raw bytes when uploads are proxied through the Worker (no presigned
 * R2 credentials). Authorized by the HMAC token from init_upload in the query
 * string (not a header, so the cross-origin PUT skips CORS preflight). The body
 * is streamed into R2 and capped at the declared size.
 */
router.put("/:file_id/blob", async (c) => {
  const settings = c.var.settings;
  const db = c.var.db;
  const { token } = parseQuery(c, z.object({ token: z.string() }));
  if (backendIsS3(settings)) httpError(404, "Not found.");
  const raw = c.req.param("file_id");
  const fid = parseFileId(raw);
  if (!(await verifyBlobToken(settings, raw, token))) httpError(403, "Invalid or expired upload token.");

  const asset = await getFileRow(db, fid);
  if (!asset) httpError(404, "File not found.");
  if (asset.status !== FILE_STATUS_PENDING_UPLOAD) httpError(409, "This upload was already finalized.");

  const markFailed = () => db.update(fileAssets).set({ status: FILE_STATUS_FAILED }).where(eq(fileAssets.id, asset.id));
  const lenHeader = c.req.header("content-length");
  try {
    await writeStream(c.env.FILES, {
      key: asset.storageKey,
      body: c.req.raw.body,
      contentLength: lenHeader ? Number(lenHeader) : null,
      maxBytes: Math.min(asset.sizeBytes, settings.workerUploadMaxBytes),
      contentType: asset.mimeType,
    });
  } catch (err) {
    if (err instanceof StorageFileTooLarge) {
      await markFailed();
      httpError(413, "Upload exceeds the declared size.");
    }
    await markFailed();
    httpError(502, `Storage error: ${(err as Error).message}`);
  }
  return c.body(null, 204);
});

/**
 * Update a file in place: replace its bytes, keep its link. The short_code,
 * serve URL and QR stay the same. The swap is atomic: old bytes keep serving
 * until the new upload has fully landed. View history is preserved.
 */
router.put("/:file_id/content", async (c) => {
  const user = await requireAuth(c);
  const settings = c.var.settings;
  const db = c.var.db;
  const { filename } = parseQuery(c, z.object({ filename: qStr() }));
  ensureStorage(settings);
  const fid = parseFileId(c.req.param("file_id"));

  const asset = await db
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.id, fid), eq(fileAssets.userId, user.userId)))
    .get();
  if (!asset || asset.status === FILE_STATUS_DELETED) httpError(404, "File not found.");
  if (asset.status !== FILE_STATUS_ACTIVE) {
    httpError(
      409,
      `Cannot replace content from status '${asset.status}'; finalize the original upload first.`,
    );
  }

  const contentType = (c.req.header("content-type") ?? "").split(";", 1)[0].trim();
  if (!contentType) httpError(400, "Content-Type header is required.");
  const kind = classify(contentType);
  // Bytes stream through the Worker, so the plan's body limit also applies.
  const cap = Math.min(KIND_CAP_BYTES[kind], settings.workerUploadMaxBytes);

  const newFilename = (filename ?? asset.filename).trim().slice(0, 255);
  // Versioned key: the live blob keeps serving until the swap below; the random
  // prefix also avoids colliding with the current key.
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const newKey = storageKey(user.userId, asset.id, `${rand}-${newFilename}`);

  const lenHeader = c.req.header("content-length");
  let written: number;
  try {
    written = await writeStream(c.env.FILES, {
      key: newKey,
      body: c.req.raw.body,
      contentLength: lenHeader ? Number(lenHeader) : null,
      maxBytes: cap,
      contentType,
    });
  } catch (err) {
    if (err instanceof StorageFileTooLarge) {
      httpError(413, `Replacement exceeds the ${Math.floor(cap / MB)} MB limit for this file type.`);
    }
    if (err instanceof StorageNotConfigured) httpError(503, "File storage is not configured.");
    if (err instanceof HTTPError) throw err;
    httpError(502, `Storage error: ${(err as Error).message}`);
  }
  if (written <= 0) {
    background(c, () => deleteBlobQuiet(c.env.FILES, newKey));
    httpError(400, "Empty request body.");
  }

  const oldKey = asset.storageKey;
  const updates = {
    storageKey: newKey,
    filename: newFilename,
    mimeType: contentType,
    kind,
    sizeBytes: written,
    sha256: null,
    serveMode: serveModeFor(c, kind),
  };
  await db.update(fileAssets).set(updates).where(eq(fileAssets.id, asset.id));
  Object.assign(asset, updates);

  if (oldKey !== newKey) background(c, () => deleteBlobQuiet(c.env.FILES, oldKey), "replace_content cleanup");
  background(c, () => computeSha256Async(c.env.FILES, db, asset.id, newKey), "sha256");
  return c.json(await fileResponse(db, settings, asset));
});

/** Lightweight 'has it been opened?' poll for a file's owner or guest token. */
router.get("/:file_id/status", async (c) => {
  const { owner_token } = parseQuery(c, z.object({ owner_token: qStr() }));
  const user = await getCurrentUser(c);
  const fid = parseFileId(c.req.param("file_id"));
  const asset = await getFileRow(c.var.db, fid);
  if (!asset || asset.status === FILE_STATUS_DELETED) httpError(404, "File not found.");
  if (!(await authorizeAsset(asset, user, owner_token))) httpError(403, "Not authorized for this file.");

  const expires = asset.expiresAt ? new Date(isoUtc(asset.expiresAt)!) : null;
  const expired = expires !== null && expires.getTime() < Date.now();
  const views = asset.viewCount ?? 0;
  return c.json({
    view_count: views,
    last_viewed_at: isoUtc(asset.lastViewedAt),
    expires_at: isoUtc(asset.expiresAt),
    status: expired ? "expired" : asset.status,
    seen: views > 0,
  });
});

// ---------------------------------------------------------------------------
// Manage
// ---------------------------------------------------------------------------

router.get("/", async (c) => {
  const user = await requireAuth(c);
  const rows = await c.var.db
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.userId, user.userId), ne(fileAssets.status, FILE_STATUS_DELETED)))
    .orderBy(desc(fileAssets.createdAt));
  const out = [];
  for (const a of rows) out.push(await fileResponse(c.var.db, c.var.settings, a));
  return c.json(out);
});

/** Update a file's mutable fields. Currently: assign it to a project (folder). */
router.patch("/:file_id", async (c) => {
  const user = await requireAuth(c);
  const { data, fields } = await parseBodyWithFields(c, FileUpdateRequest);
  const asset = await getOwnedFile(c, c.req.param("file_id"), user.userId);
  if (fields.has("project_id")) {
    let projectId: string | null = null;
    if (data.project_id) {
      projectId = canonicalUuid(data.project_id);
      if (!projectId) httpError(400, "Invalid project_id.");
      const owns = await c.var.db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, user.userId)))
        .get();
      if (!owns) httpError(404, "Project not found.");
    }
    await c.var.db.update(fileAssets).set({ projectId }).where(eq(fileAssets.id, asset.id));
    asset.projectId = projectId;
  }
  return c.json(await fileResponse(c.var.db, c.var.settings, asset));
});

/**
 * Set self-destruct / access controls (owner only). Only fields present in the
 * body change; for the int limits send 0 to clear and a positive number to set.
 */
router.put("/:file_id/access", async (c) => {
  const user = await requireAuth(c);
  const { data, fields } = await parseBodyWithFields(c, FileAccessRequest);
  const asset = await getOwnedFile(c, c.req.param("file_id"), user.userId);
  const now = nowIso();
  const updates: Partial<typeof fileAssets.$inferInsert> = {};
  if (fields.has("expires_in_hours")) {
    updates.expiresAt = data.expires_in_hours ? secondsFromNow(data.expires_in_hours * 3600) : null;
  }
  if (fields.has("max_views")) updates.maxViews = data.max_views && data.max_views > 0 ? data.max_views : null;
  if (fields.has("require_email")) updates.requireEmail = !!data.require_email;
  if (fields.has("block_vpn")) updates.blockVpn = !!data.block_vpn;
  if (fields.has("branded")) updates.branded = !!data.branded;
  if (fields.has("revoked")) updates.revokedAt = data.revoked ? now : null;
  if (Object.keys(updates).length) {
    await c.var.db.update(fileAssets).set(updates).where(eq(fileAssets.id, asset.id));
    Object.assign(asset, updates);
  }
  return c.json(await fileResponse(c.var.db, c.var.settings, asset));
});

/** Emails captured by this file's access gate (owner only). */
router.get("/:file_id/leads", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedFile(c, c.req.param("file_id"), user.userId);
  const rows = await c.var.db
    .select()
    .from(accessLeads)
    .where(eq(accessLeads.fileId, asset.id))
    .orderBy(desc(accessLeads.createdAt));
  return c.json(rows.map((r) => ({ email: r.email, ip_address: r.ipAddress, created_at: isoUtc(r.createdAt) ?? "" })));
});

/**
 * Per-page engagement heatmap for a document (owner only): per page, average
 * dwell (ms), total dwell, and how many view-sessions reached it.
 */
router.get("/:file_id/pages", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedFile(c, c.req.param("file_id"), user.userId);
  const rows = await c.var.db
    .select({
      page: pageEngagements.page,
      avg_ms: sql<number>`avg(${pageEngagements.dwellMs})`,
      total_ms: sql<number>`sum(${pageEngagements.dwellMs})`,
      sessions: sql<number>`count(distinct ${pageEngagements.sessionId})`,
    })
    .from(pageEngagements)
    .where(eq(pageEngagements.fileId, asset.id))
    .groupBy(pageEngagements.page)
    .orderBy(pageEngagements.page);
  const pages = rows.map((r) => ({
    page: Math.trunc(Number(r.page)),
    avg_ms: Math.trunc(Number(r.avg_ms ?? 0)),
    total_ms: Math.trunc(Number(r.total_ms ?? 0)),
    sessions: Math.trunc(Number(r.sessions ?? 0)),
  }));
  const peak = pages.reduce((m, p) => Math.max(m, p.avg_ms), 0);
  return c.json({ pages, peak_avg_ms: peak });
});

// ---------------------------------------------------------------------------
// Per-file analytics (owner only). File opens are ClickEvent rows with file_id
// set, so these mirror /utm/analytics/links/{id}/* filtered by file_id.
// ---------------------------------------------------------------------------

async function analyticsScope(c: Ctx) {
  const q = parseQuery(c, AnalyticsQuery);
  const user = await requireAuth(c);
  const asset = await getOwnedFile(c, c.req.param("file_id") ?? "", user.userId);
  const [start, end] = dateRange(q.days ?? 30, q.start_date, q.end_date);
  const where = and(
    eq(clickEvents.fileId, asset.id),
    sql`${clickEvents.clickedAt} >= ${start}`,
    sql`${clickEvents.clickedAt} <= ${end}`,
  );
  return { asset, where };
}

/** Headline open stats for one file. */
router.get("/:file_id/summary", async (c) => {
  const { asset, where } = await analyticsScope(c);
  const row = await c.var.db
    .select({
      opens: sql<number>`count(${clickEvents.id})`,
      unique_opens: sql<number>`count(distinct ${clickEvents.ipAddress})`,
    })
    .from(clickEvents)
    .where(where)
    .get();
  return c.json({
    file_id: asset.id,
    filename: asset.filename,
    short_code: asset.shortCode,
    view_count: asset.viewCount ?? 0,
    opens: Number(row?.opens ?? 0),
    unique_opens: Number(row?.unique_opens ?? 0),
    last_viewed_at: isoUtc(asset.lastViewedAt),
    created_at: isoUtc(asset.createdAt),
  });
});

/** Individual opens for one file (most recent 500). */
router.get("/:file_id/events", async (c) => {
  const { where } = await analyticsScope(c);
  const events = await c.var.db
    .select()
    .from(clickEvents)
    .where(where)
    .orderBy(desc(clickEvents.clickedAt))
    .limit(500);
  return c.json(
    events.map((e) => ({
      id: e.id,
      ip_address: e.ipAddress,
      device_type: e.deviceType,
      browser: e.browser,
      os: e.os,
      country: e.country,
      country_code: e.countryCode,
      region: e.region,
      city: e.city,
      referrer: e.referrer,
      is_vpn: !!e.isVpn,
      asn_org: e.asnOrg,
      clicked_at: isoUtc(e.clickedAt),
    })),
  );
});

/** Geographic breakdown of opens for one file (country | region | city). */
router.get("/:file_id/geo", async (c) => {
  const { level } = parseQuery(c, z.object({ level: qStr("country") }));
  const { where } = await analyticsScope(c);
  const db = c.var.db;
  const clicks = sql<number>`count(${clickEvents.id})`;
  if (level === "region") {
    const rows = await db
      .select({ country: clickEvents.country, country_code: clickEvents.countryCode, region: clickEvents.region, clicks })
      .from(clickEvents)
      .where(where)
      .groupBy(clickEvents.country, clickEvents.countryCode, clickEvents.region)
      .orderBy(desc(clicks));
    return c.json(rows.map((r) => ({ ...r, clicks: Number(r.clicks) })));
  }
  if (level === "city") {
    const rows = await db
      .select({
        country: clickEvents.country,
        country_code: clickEvents.countryCode,
        region: clickEvents.region,
        city: clickEvents.city,
        clicks,
      })
      .from(clickEvents)
      .where(where)
      .groupBy(clickEvents.country, clickEvents.countryCode, clickEvents.region, clickEvents.city)
      .orderBy(desc(clicks));
    return c.json(rows.map((r) => ({ ...r, clicks: Number(r.clicks) })));
  }
  const rows = await db
    .select({ country: clickEvents.country, country_code: clickEvents.countryCode, clicks })
    .from(clickEvents)
    .where(where)
    .groupBy(clickEvents.country, clickEvents.countryCode)
    .orderBy(desc(clicks));
  return c.json(rows.map((r) => ({ ...r, clicks: Number(r.clicks) })));
});

/** Device + browser breakdown of opens for one file. */
router.get("/:file_id/devices", async (c) => {
  const { where } = await analyticsScope(c);
  const db = c.var.db;
  const clicks = sql<number>`count(${clickEvents.id})`;
  const devices = await db
    .select({ device_type: clickEvents.deviceType, clicks })
    .from(clickEvents)
    .where(where)
    .groupBy(clickEvents.deviceType)
    .orderBy(desc(clicks));
  const browsers = await db
    .select({ browser: clickEvents.browser, clicks })
    .from(clickEvents)
    .where(where)
    .groupBy(clickEvents.browser)
    .orderBy(desc(clicks));
  return c.json({
    devices: devices.map((r) => ({ device_type: r.device_type, clicks: Number(r.clicks) })),
    browsers: browsers.map((r) => ({ browser: r.browser, clicks: Number(r.clicks) })),
  });
});

router.delete("/:file_id", async (c) => {
  const user = await requireAuth(c);
  const fid = parseFileId(c.req.param("file_id"));
  const asset = await c.var.db
    .select()
    .from(fileAssets)
    .where(and(eq(fileAssets.id, fid), eq(fileAssets.userId, user.userId)))
    .get();
  if (!asset) httpError(404, "File not found.");
  await c.var.db.update(fileAssets).set({ status: FILE_STATUS_DELETED }).where(eq(fileAssets.id, asset.id));
  background(c, () => deleteBlobQuiet(c.env.FILES, asset.storageKey), "delete_object");
  return c.body(null, 204);
});
