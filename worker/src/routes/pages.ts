/**
 * Port of backend/app/api/v1/pages.py — mounted at /api/v1/pages.
 *
 * Beam Pages: publish, update, manage and analyse hosted single-file HTML
 * pages. A page is a FileAsset (kind=html) behind a permanent trackable link.
 * Publishing is one call (JSON `html` or a multipart `.html` upload); updates
 * keep the URL and QR forever; every content change is retained as a version
 * for rollback. Serving lives in the public /f and /p routes (filesServe.ts).
 *
 * Auth: Clerk session, user API key (cb_live_*), or the service-key lane on the
 * write routes allowlisted in auth/serviceAuth.ts.
 */
import { Hono } from "hono";
import { and, desc, eq, max, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { requireAuth, type TokenData } from "../auth/security";
import { isUniqueViolation } from "../db/client";
import {
  FILE_KIND_HTML,
  FILE_STATUS_ACTIVE,
  FILE_STATUS_DELETED,
  SERVE_STREAM,
  clickEvents,
  fileAssets,
  fileVersions,
  pageComments,
  pageEngagements,
  pageEvents,
  pageState,
} from "../db/schema";
import { setAccessCode } from "../lib/accessControl";
import { background } from "../lib/background";
import { sha256Hex } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { StorageError, StorageNotConfigured, getObject, putBytes } from "../lib/storage";
import { isoUtc, nowIso } from "../lib/time";
import { parseQuery, qInt, qStr } from "../lib/validate";
import { resolveMemberDomain, schemeFor } from "../services/content";
import { assertCanShare, shareOrgUuid } from "../services/domains";
import * as pagesService from "../services/pages";
import { rotateStateToken } from "../services/pageState";
import {
  allocateUniqueShortCode,
  blobAvailability,
  canonicalUuid,
  dateRange,
  deleteBlobQuiet,
  hostedCond,
  ensureStorage,
  parseBodyWithFields,
  publicUrl,
  serveHost,
  storageKey,
  type FileAsset,
} from "./_files";

export const router = new Hono<AppEnv>({ strict: false });

const HTML_MIME = "text/html";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const PagePublish = z.object({
  html: z.string().min(1),
  title: z.string().max(200).default("Untitled page"),
  domain_id: z.string().nullable().optional(),
  slug: z.string().max(80).nullable().optional(),
});

const PageUpdate = z.object({
  html: z.string().min(1),
  title: z.string().max(200).nullable().optional(),
});

const PagePatch = z.object({
  title: z.string().max(200).nullable().optional(),
  slug: z.string().max(80).nullable().optional(),
  enabled: z.boolean().nullable().optional(),
  domain_id: z.string().nullable().optional(),
  // 4–8 digit access code; null clears.
  access_code: z.string().max(8).nullable().optional(),
});

const DateQuery = { days: qInt(30, { ge: 1, le: 365 }), start_date: qStr(), end_date: qStr() };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function removeSuffix(s: string, suffix: string): string {
  return suffix && s.endsWith(suffix) ? s.slice(0, -suffix.length) : s;
}

function titleFromFilename(filename: string): string {
  return removeSuffix(removeSuffix(filename, ".html"), ".htm").replace(/-/g, " ") || "Untitled page";
}

function filenameFor(title: string): string {
  return `${pagesService.slugify(title)}.html`;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

function randHex8(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

async function getOwnedPage(c: Ctx, pageId: string, user: TokenData): Promise<FileAsset> {
  const pid = canonicalUuid(pageId);
  if (!pid) httpError(400, "Invalid page id.");
  const asset = await c.var.db
    .select()
    .from(fileAssets)
    .where(
      and(
        eq(fileAssets.id, pid),
        eq(fileAssets.userId, user.userId),
        hostedCond,
        ne(fileAssets.status, FILE_STATUS_DELETED),
      ),
    )
    .get();
  if (!asset) httpError(404, "Page not found.");
  return asset;
}

async function resolveDomainId(c: Ctx, user: TokenData, domainId: string | null | undefined): Promise<string | null> {
  const d = await resolveMemberDomain(c.var.db, user.userId, domainId, shareOrgUuid(user));
  return d ? d.id : null;
}

async function writeBlob(c: Ctx, key: string, payload: Uint8Array): Promise<void> {
  try {
    await putBytes(c.env.FILES, key, payload, HTML_MIME);
  } catch (err) {
    if (err instanceof StorageNotConfigured) httpError(503, "File storage is not configured.");
    httpError(502, `Storage error: ${(err as Error).message}`);
  }
}

/** unique_visitors / revisits / total_dwell_ms for one page (all time). */
async function engagementStats(c: Ctx, asset: FileAsset) {
  const db = c.var.db;
  const views = await db
    .select({
      uniq: sql<number>`count(distinct ${clickEvents.visitorId})`,
      uniqIp: sql<number>`count(distinct ${clickEvents.ipAddress})`,
      revisits: sql<number>`coalesce(sum(${clickEvents.isRevisit}), 0)`,
    })
    .from(clickEvents)
    .where(eq(clickEvents.fileId, asset.id))
    .get();
  const dwell = await db
    .select({ total: sql<number>`coalesce(sum(${pageEngagements.dwellMs}), 0)` })
    .from(pageEngagements)
    .where(eq(pageEngagements.fileId, asset.id))
    .get();
  return {
    unique_visitors: Math.trunc(Number(views?.uniq || views?.uniqIp || 0)),
    revisits: Math.trunc(Number(views?.revisits || 0)),
    total_dwell_ms: Math.trunc(Number(dwell?.total || 0)),
  };
}

async function pageResponse(c: Ctx, asset: FileAsset) {
  const db = c.var.db;
  const host = await serveHost(db, c.var.settings, asset.userId, asset.domainId);
  const stats = await engagementStats(c, asset);
  const versionNo = await pagesService.currentVersionNo(db, asset);
  const latest = await db
    .select({ at: max(fileVersions.createdAt) })
    .from(fileVersions)
    .where(eq(fileVersions.fileId, asset.id))
    .get();
  const slug = asset.slug ?? null;
  const legacy = `https://${host}/f/${asset.shortCode}`;
  return {
    page_id: asset.id,
    short_code: asset.shortCode,
    slug,
    url: slug ? `https://${host}/p/${slug}` : legacy,
    public_url: publicUrl(host, asset),
    legacy_url: legacy,
    title: titleFromFilename(asset.filename),
    size_bytes: asset.sizeBytes,
    view_count: asset.viewCount ?? 0,
    unique_visitors: stats.unique_visitors,
    revisits: stats.revisits,
    total_dwell_ms: stats.total_dwell_ms,
    enabled: asset.revokedAt == null,
    has_access_code: !!asset.accessCodeHash,
    domain_id: asset.domainId ?? null,
    created_at: isoUtc(asset.createdAt) ?? "",
    updated_at: isoUtc(latest?.at || asset.createdAt) ?? "",
    current_version: versionNo,
  };
}

async function publish(
  c: Ctx,
  opts: {
    user: TokenData;
    payload: Uint8Array;
    title: string;
    domainId: string | null | undefined;
    slug: string | null | undefined;
    filename: string | null;
    contentType: string | null;
  },
): Promise<FileAsset> {
  const settings = c.var.settings;
  const db = c.var.db;
  ensureStorage(settings);
  pagesService.validateHtmlUpload(
    settings,
    opts.filename || `${pagesService.slugify(opts.title)}.html`,
    opts.contentType,
    opts.payload,
  );
  const domainId = await resolveDomainId(c, opts.user, opts.domainId);
  assertCanShare(opts.user);

  let slug: string;
  if (opts.slug) {
    slug = pagesService.validateSlug(opts.slug);
    if (await pagesService.slugTaken(db, slug, domainId)) httpError(409, "That slug is already taken.");
  } else {
    slug = await pagesService.uniqueSlug(db, opts.title, domainId);
  }

  const shortCode = await allocateUniqueShortCode(db, domainId);
  const fileId = crypto.randomUUID();
  const storedName = filenameFor(opts.title);
  const key = storageKey(opts.user.userId, fileId, storedName);
  await writeBlob(c, key, opts.payload);
  const sha = await sha256Hex(opts.payload);

  let inserted: FileAsset[];
  try {
    const [rows] = await db.batch([
      db
        .insert(fileAssets)
        .values({
          id: fileId,
          userId: opts.user.userId,
          domainId,
          organizationId: shareOrgUuid(opts.user),
          shareIntent: "host",
          shortCode,
          slug,
          filename: storedName,
          kind: FILE_KIND_HTML,
          mimeType: HTML_MIME,
          sizeBytes: opts.payload.length,
          sha256: sha,
          storageKey: key,
          status: FILE_STATUS_ACTIVE,
          serveMode: SERVE_STREAM,
          viewCount: 0,
          createdAt: nowIso(),
        })
        .returning(),
      pagesService.versionInsert(db, fileId, 1, {
        storageKey: key,
        sizeBytes: opts.payload.length,
        sha256: sha,
        filename: storedName,
      }),
    ]);
    inserted = rows;
  } catch (err) {
    if (isUniqueViolation(err)) {
      background(c, () => deleteBlobQuiet(c.env.FILES, key));
      httpError(409, "That slug is already taken.");
    }
    throw err;
  }
  return inserted[0];
}

// ---------------------------------------------------------------------------
// Publish / list / read / delete
// ---------------------------------------------------------------------------

/**
 * Publish an HTML page and get its permanent trackable URL (`/p/{slug}`).
 * Optional `slug` (else derived from the title), optional `domain_id`.
 */
router.post("/", async (c) => {
  const user = await requireAuth(c);
  const { data } = await parseBodyWithFields(c, PagePublish);
  const asset = await publish(c, {
    user,
    payload: utf8(data.html),
    title: data.title,
    domainId: data.domain_id,
    slug: data.slug,
    filename: null,
    contentType: HTML_MIME,
  });
  return c.json(await pageResponse(c, asset), 201);
});

/** Publish by uploading a single .html file (multipart). */
router.post("/upload", async (c) => {
  const user = await requireAuth(c);
  let form: Record<string, string | File | (string | File)[]> = {};
  try {
    form = (await c.req.parseBody()) as typeof form;
  } catch {
    form = {};
  }
  const file = form.file;
  if (!(file instanceof File)) {
    httpError(422, [
      { type: "missing", loc: ["body", "file"], msg: "Field required", input: null },
    ]);
  }
  const str = (k: string): string | null => {
    const v = form[k];
    return typeof v === "string" ? v : null;
  };
  const maxBytes = c.var.settings.pagesMaxBytes;
  const payload = new Uint8Array(await file.slice(0, maxBytes + 1).arrayBuffer());
  const title = (str("title") || titleFromFilename(file.name || "")).trim() || "Untitled page";
  const asset = await publish(c, {
    user,
    payload,
    title,
    domainId: str("domain_id"),
    slug: str("slug"),
    filename: file.name || null,
    contentType: file.type || null,
  });
  return c.json(await pageResponse(c, asset), 201);
});

/**
 * Slug the composer should offer for an upload: basename without its final
 * extension, numbered on collision in the chosen host's namespace. Read-only:
 * nothing is reserved until the page is created.
 */
router.get("/slug-suggestion", async (c) => {
  const user = await requireAuth(c);
  const q = parseQuery(c, z.object({ filename: qStr(""), domain_id: qStr("") }));
  const domainId = await resolveDomainId(c, user, q.domain_id || null);
  const base = pagesService.slugFromFilename(q.filename);
  const slug = await pagesService.suggestSlug(c.var.db, base, domainId);
  const host = await serveHost(c.var.db, c.var.settings, user.userId, domainId);
  return c.json({ slug, base, collided: slug !== base, host, public_url: `${schemeFor(host)}://${host}/${slug}` });
});

/** Your pages, newest first. */
router.get("/", async (c) => {
  const user = await requireAuth(c);
  const db = c.var.db;
  const rows = await db
    .select()
    .from(fileAssets)
    .where(
      and(eq(fileAssets.userId, user.userId), hostedCond, ne(fileAssets.status, FILE_STATUS_DELETED)),
    )
    .orderBy(desc(fileAssets.createdAt));
  // Pre-Beam-Pages uploads get a slug on first sight (persisted by ensureSlug).
  for (const a of rows) await pagesService.ensureSlug(db, a, titleFromFilename(a.filename));
  const out = [];
  for (const a of rows) out.push(await pageResponse(c, a));
  return c.json(out);
});

/** Lazy per-item blob check for the UI: missing vs forbidden vs storage outage. */
router.get("/:page_id/availability", async (c) =>
  blobAvailability(c, c.req.param("page_id"), await requireAuth(c), true),
);

router.get("/:page_id", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  await pagesService.ensureSlug(c.var.db, asset, titleFromFilename(asset.filename));
  return c.json(await pageResponse(c, asset));
});

/**
 * Kill switch + cleanup: the URL stops resolving immediately (404) and every
 * retained version blob is removed.
 */
router.delete("/:page_id", async (c) => {
  const user = await requireAuth(c);
  const db = c.var.db;
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const versions = await pagesService.listVersions(db, asset);
  const keys = new Set([...versions.map((v) => v.storageKey), asset.storageKey]);
  await db.batch([
    db.delete(fileVersions).where(eq(fileVersions.fileId, asset.id)),
    db.update(fileAssets).set({ status: FILE_STATUS_DELETED }).where(eq(fileAssets.id, asset.id)),
  ]);
  for (const key of keys) background(c, () => deleteBlobQuiet(c.env.FILES, key), "delete page blob");
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// Update in place / settings
// ---------------------------------------------------------------------------

/**
 * Replace the page content. URL, slug, short code and QR stay identical.
 * Atomic swap: the previous version keeps serving until the new bytes have
 * fully landed, and is retained for rollback (last `pagesVersionsKeep`).
 */
router.put("/:page_id", async (c) => {
  const user = await requireAuth(c);
  const { data } = await parseBodyWithFields(c, PageUpdate);
  const settings = c.var.settings;
  ensureStorage(settings);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  if (asset.status !== FILE_STATUS_ACTIVE) httpError(409, `Page is in status '${asset.status}'.`);
  if (asset.kind !== FILE_KIND_HTML) httpError(409, "Only HTML pages take inline content; replace media through /files.");

  const payload = utf8(data.html);
  pagesService.validateHtmlUpload(settings, asset.filename, HTML_MIME, payload);
  const filename = data.title ? filenameFor(data.title) : asset.filename;
  const newKey = storageKey(user.userId, asset.id, `${randHex8()}-${filename}`);
  await writeBlob(c, newKey, payload);

  const { doomed } = await pagesService.replaceContent(
    c.var.db,
    asset,
    { storageKey: newKey, sizeBytes: payload.length, sha256: await sha256Hex(payload), filename },
    { keep: settings.pagesVersionsKeep, snapshot: true },
  );
  for (const key of doomed) background(c, () => deleteBlobQuiet(c.env.FILES, key), "prune version blob");
  return c.json(await pageResponse(c, asset));
});

/** Change settings without touching content: slug, title, enabled (kill switch), domain, access code. */
router.patch("/:page_id", async (c) => {
  const user = await requireAuth(c);
  const { data, fields } = await parseBodyWithFields(c, PagePatch);
  const db = c.var.db;
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const updates: Partial<typeof fileAssets.$inferInsert> = {};

  if (fields.has("domain_id")) {
    updates.domainId = asset.domainId = await resolveDomainId(c, user, data.domain_id);
  }
  if (fields.has("slug") && data.slug != null) {
    const slug = pagesService.validateSlug(data.slug);
    if (await pagesService.slugTaken(db, slug, asset.domainId ?? null, { excludeId: asset.id })) {
      httpError(409, "That slug is already taken.");
    }
    if (slug !== asset.slug) await pagesService.retireSlug(db, asset);
    updates.slug = asset.slug = slug;
  }
  if (fields.has("title") && data.title) {
    updates.filename = asset.filename = filenameFor(data.title);
  }
  if (fields.has("enabled") && data.enabled != null) {
    updates.revokedAt = asset.revokedAt = data.enabled ? null : nowIso();
  }
  if (fields.has("access_code")) {
    updates.accessCodeHash = await setAccessCode(c.var.settings, asset, data.access_code);
  }

  if (Object.keys(updates).length) {
    try {
      await db.update(fileAssets).set(updates).where(eq(fileAssets.id, asset.id));
    } catch (err) {
      if (isUniqueViolation(err)) httpError(409, "That slug is already taken.");
      throw err;
    }
  }
  return c.json(await pageResponse(c, asset));
});

// ---------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------

router.get("/:page_id/versions", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const versions = await pagesService.listVersions(c.var.db, asset);
  return c.json(
    versions.map((v) => ({
      version_no: v.versionNo,
      size_bytes: v.sizeBytes,
      sha256: v.sha256,
      filename: v.filename,
      created_at: isoUtc(v.createdAt) ?? "",
      current: v.storageKey === asset.storageKey,
    })),
  );
});

/**
 * Make an older version current. Recorded as a NEW version (history stays
 * linear and the rollback itself can be rolled back).
 */
router.post("/:page_id/versions/:version_no/rollback", async (c) => {
  const rawNo = c.req.param("version_no");
  if (!/^[+-]?\d+$/.test(rawNo.trim())) {
    httpError(422, [
      {
        type: "int_parsing",
        loc: ["path", "version_no"],
        msg: "Input should be a valid integer, unable to parse string as an integer",
        input: rawNo,
      },
    ]);
  }
  const versionNo = Number.parseInt(rawNo.trim(), 10);
  const user = await requireAuth(c);
  const settings = c.var.settings;
  const db = c.var.db;
  ensureStorage(settings);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const target = await db
    .select()
    .from(fileVersions)
    .where(and(eq(fileVersions.fileId, asset.id), eq(fileVersions.versionNo, versionNo)))
    .get();
  if (!target) httpError(404, "Version not found.");
  if (target.storageKey === asset.storageKey) return c.json(await pageResponse(c, asset));

  let payload: Uint8Array;
  try {
    const obj = await getObject(c.env.FILES, target.storageKey);
    payload = new Uint8Array(await obj.arrayBuffer());
  } catch (err) {
    if (err instanceof StorageError) httpError(502, `Storage error: ${err.message}`);
    throw err;
  }
  const newKey = storageKey(user.userId, asset.id, `${randHex8()}-${target.filename}`);
  await writeBlob(c, newKey, payload);

  const { doomed } = await pagesService.replaceContent(
    db,
    asset,
    {
      storageKey: newKey,
      sizeBytes: payload.length,
      sha256: target.sha256 || (await sha256Hex(payload)),
      filename: target.filename,
    },
    { keep: settings.pagesVersionsKeep },
  );
  for (const key of doomed) background(c, () => deleteBlobQuiet(c.env.FILES, key), "prune version blob");
  return c.json(await pageResponse(c, asset));
});

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

/** Python statistics.median (mean of the two middles for an even count). */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Headline numbers for one page in a window: views, unique visitors,
 * revisits, and dwell (total + median per visit session).
 */
router.get("/:page_id/analytics", async (c) => {
  const q = parseQuery(c, z.object(DateQuery));
  const user = await requireAuth(c);
  const db = c.var.db;
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const [start, end] = dateRange(q.days ?? 30, q.start_date, q.end_date);

  const row = await db
    .select({
      views: sql<number>`count(${clickEvents.id})`,
      uniq: sql<number>`count(distinct ${clickEvents.visitorId})`,
      uniqIp: sql<number>`count(distinct ${clickEvents.ipAddress})`,
      revisits: sql<number>`coalesce(sum(${clickEvents.isRevisit}), 0)`,
    })
    .from(clickEvents)
    .where(
      and(
        eq(clickEvents.fileId, asset.id),
        sql`${clickEvents.clickedAt} >= ${start}`,
        sql`${clickEvents.clickedAt} <= ${end}`,
      ),
    )
    .get();

  const perSession = await db
    .select({ total: sql<number>`sum(${pageEngagements.dwellMs})` })
    .from(pageEngagements)
    .where(
      and(
        eq(pageEngagements.fileId, asset.id),
        sql`${pageEngagements.createdAt} >= ${start}`,
        sql`${pageEngagements.createdAt} <= ${end}`,
      ),
    )
    .groupBy(pageEngagements.sessionId);
  const dwells = perSession.map((r) => Math.trunc(Number(r.total || 0)));
  const totalDwell = dwells.reduce((a, b) => a + b, 0);

  return c.json({
    page_id: asset.id,
    slug: asset.slug ?? null,
    short_code: asset.shortCode,
    title: titleFromFilename(asset.filename),
    view_count: asset.viewCount ?? 0,
    views: Number(row?.views || 0),
    unique_visitors: Math.trunc(Number(row?.uniq || row?.uniqIp || 0)),
    revisits: Math.trunc(Number(row?.revisits || 0)),
    sessions: dwells.length,
    total_dwell_ms: totalDwell,
    median_dwell_ms: dwells.length ? Math.trunc(median(dwells)) : 0,
    avg_dwell_ms: dwells.length ? Math.trunc(totalDwell / dwells.length) : 0,
    last_viewed_at: isoUtc(asset.lastViewedAt),
    created_at: isoUtc(asset.createdAt),
  });
});

// ---------------------------------------------------------------------------
// Beam State — owner moderation + timeline
// ---------------------------------------------------------------------------

router.get("/:page_id/comments", async (c) => {
  const { limit } = parseQuery(c, z.object({ limit: qInt(200, { ge: 1, le: 1000 }) }));
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const rows = await c.var.db
    .select()
    .from(pageComments)
    .where(eq(pageComments.pageId, asset.id))
    .orderBy(desc(pageComments.createdAt))
    .limit(limit ?? 200);
  return c.json(
    rows.map((r) => ({
      id: r.id,
      author: r.author,
      body: r.body,
      visitor_id: r.visitorId,
      ip: r.ip,
      created_at: isoUtc(r.createdAt),
    })),
  );
});

router.delete("/:page_id/comments/:comment_id", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const cid = canonicalUuid(c.req.param("comment_id"));
  if (!cid) httpError(400, "Invalid comment id.");
  const deleted = await c.var.db
    .delete(pageComments)
    .where(and(eq(pageComments.id, cid), eq(pageComments.pageId, asset.id)))
    .returning({ id: pageComments.id });
  if (!deleted.length) httpError(404, "Comment not found.");
  return c.body(null, 204);
});

router.get("/:page_id/state", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const rows = await c.var.db
    .select()
    .from(pageState)
    .where(eq(pageState.pageId, asset.id))
    .orderBy(pageState.key);
  const state: Record<string, unknown> = {};
  for (const r of rows) state[r.key] = r.value;
  return c.json({ state, count: rows.length });
});

router.delete("/:page_id/state", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  await c.var.db.delete(pageState).where(eq(pageState.pageId, asset.id));
  return c.body(null, 204);
});

router.delete("/:page_id/state/:key", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  await c.var.db
    .delete(pageState)
    .where(and(eq(pageState.pageId, asset.id), eq(pageState.key, c.req.param("key"))));
  return c.body(null, 204);
});

/** Mint a new public token; the old one is rejected immediately. */
router.post("/:page_id/state-token/rotate", async (c) => {
  const user = await requireAuth(c);
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  return c.json({ state_token: await rotateStateToken(c.var.db, asset) });
});

/**
 * Merged page timeline: views (revisits flagged) plus comment, state and gate
 * events, newest first.
 */
router.get("/:page_id/events", async (c) => {
  const q = parseQuery(c, z.object({ ...DateQuery, limit: qInt(500, { ge: 1, le: 1000 }) }));
  const user = await requireAuth(c);
  const db = c.var.db;
  const asset = await getOwnedPage(c, c.req.param("page_id"), user);
  const [start, end] = dateRange(q.days ?? 30, q.start_date, q.end_date);
  const limit = q.limit ?? 500;

  const views = await db
    .select()
    .from(clickEvents)
    .where(
      and(
        eq(clickEvents.fileId, asset.id),
        sql`${clickEvents.clickedAt} >= ${start}`,
        sql`${clickEvents.clickedAt} <= ${end}`,
      ),
    )
    .orderBy(desc(clickEvents.clickedAt))
    .limit(limit);
  const others = await db
    .select()
    .from(pageEvents)
    .where(
      and(
        eq(pageEvents.pageId, asset.id),
        sql`${pageEvents.createdAt} >= ${start}`,
        sql`${pageEvents.createdAt} <= ${end}`,
      ),
    )
    .orderBy(desc(pageEvents.createdAt))
    .limit(limit);

  const timeline = [
    ...views.map((e) => ({
      _sort: isoUtc(e.clickedAt) ?? "",
      type: e.isRevisit ? "revisit" : "view",
      ts: isoUtc(e.clickedAt),
      ip: e.ipAddress,
      visitor_id: e.visitorId,
      ref: null as string | null,
      country: e.country,
      city: e.city,
      device_type: e.deviceType,
      browser: e.browser,
      os: e.os,
      is_vpn: !!e.isVpn,
    })),
    ...others.map((p) => ({
      _sort: isoUtc(p.createdAt) ?? "",
      type: p.eventType,
      ts: isoUtc(p.createdAt),
      ip: p.ip,
      visitor_id: p.visitorId,
      ref: p.ref,
      country: null,
      city: null,
      device_type: null,
      browser: null,
      os: null,
      is_vpn: false,
    })),
  ];
  // Stable sort, newest first (canonical ISO text sorts chronologically).
  timeline.sort((a, b) => (a._sort < b._sort ? 1 : a._sort > b._sort ? -1 : 0));
  return c.json(timeline.slice(0, limit).map(({ _sort, ...item }) => item));
});

