/**
 * Port of backend/app/api/v1/content.py — mounted at /api/v1/content.
 *
 * Shared content library endpoints (org-scoped). Admins curate canonical
 * content; members browse and share it. Every endpoint is scoped to the
 * caller's active organization (from the Clerk session token), and
 * write/admin operations are gated by the org role.
 */
import { Hono } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Settings } from "../env";
import { requireOrgAdmin, requireOrgMember } from "../auth/security";
import type { Db } from "../db/client";
import {
  CONTENT_KIND_FILE,
  CONTENT_KIND_LINK,
  FILE_STATUS_ACTIVE,
  clickEvents,
  contentItems,
  contentShares,
  domains,
  fileAssets,
  linkClicks,
} from "../db/schema";
import { httpError } from "../lib/errors";
import { isoUtc, nowIso } from "../lib/time";
import { parseJson } from "../lib/validate";
import {
  type Content,
  type ContentShare,
  buildShareUrl,
  getOrCreateChampvaultContent,
  mintShare,
  platformHost,
} from "../services/content";
import { ChampVault, ChampVaultNotConfigured } from "./_champvault";
import { orgUuidForUser, pyUuid } from "./_org";

export const router = new Hono<AppEnv>({ strict: false });

// ============================================================================
// Schemas
// ============================================================================

const ContentCreate = z.object({
  title: z.string().min(1).max(255),
  description: z.string().nullish(),
  kind: z.string().regex(/^(file|link)$/),
  canonical_url: z.string().nullish(),
  file_id: z.string().nullish(),
});

const ContentUpdate = z.object({
  title: z.string().max(255).nullish(),
  description: z.string().nullish(),
  is_archived: z.boolean().nullish(),
});

const ChampVaultAddRequest = z.object({
  asset_id: z.string().min(1).max(64),
  // Optional overrides; when omitted we resolve title/description from ChampVault.
  title: z.string().max(255).nullish(),
  description: z.string().nullish(),
});

interface MyShare {
  share_id: string;
  share_url: string;
  opens: number;
}

// ============================================================================
// Helpers
// ============================================================================

async function getOrgContent(db: Db, contentId: string, orgUuid: string): Promise<Content> {
  const cid = pyUuid(contentId);
  if (!cid) httpError(400, "Invalid content id.");
  const content = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, cid), eq(contentItems.organizationId, orgUuid)))
    .get();
  if (!content) httpError(404, "Content not found.");
  return content;
}

async function opensForShare(db: Db, share: ContentShare): Promise<number> {
  let where;
  if (share.linkId) where = eq(clickEvents.linkId, share.linkId);
  else if (share.fileId) where = eq(clickEvents.fileId, share.fileId);
  else return 0;
  const row = await db.select({ n: count(clickEvents.id) }).from(clickEvents).where(where).get();
  return Number(row?.n ?? 0);
}

async function hostnameForShare(db: Db, settings: Settings, share: ContentShare): Promise<string> {
  if (share.domainId) {
    const row = await db.select({ hostname: domains.hostname }).from(domains).where(eq(domains.id, share.domainId)).get();
    if (row?.hostname) return row.hostname;
  }
  return platformHost(settings);
}

function contentResponse(content: Content, shareCount: number, myShare: MyShare | null) {
  return {
    id: content.id,
    title: content.title,
    description: content.description,
    kind: content.kind,
    canonical_url: content.canonicalUrl,
    // Set when this library item is a live reference to an external ChampVault
    // asset (member shares re-mint a fresh delivery URL on each open). The UI
    // uses this to badge the item and hide the internal champvault:// marker URL.
    champvault_asset_id: content.champvaultAssetId ?? null,
    file_id: content.fileId || null,
    is_archived: !!content.isArchived,
    created_at: isoUtc(content.createdAt) ?? "",
    share_count: shareCount,
    my_share: myShare,
  };
}

async function shareCount(db: Db, contentId: string): Promise<number> {
  const row = await db
    .select({ n: count(contentShares.id) })
    .from(contentShares)
    .where(eq(contentShares.contentId, contentId))
    .get();
  return Number(row?.n ?? 0);
}

async function buildMyShare(db: Db, settings: Settings, share: ContentShare): Promise<MyShare> {
  const link = share.linkId
    ? ((await db.select().from(linkClicks).where(eq(linkClicks.id, share.linkId)).get()) ?? null)
    : null;
  const file = share.fileId
    ? ((await db.select().from(fileAssets).where(eq(fileAssets.id, share.fileId)).get()) ?? null)
    : null;
  const hostname = await hostnameForShare(db, settings, share);
  return {
    share_id: share.id,
    share_url: buildShareUrl(settings, { link, file, hostname }),
    opens: await opensForShare(db, share),
  };
}

// ============================================================================
// Endpoints
// ============================================================================

/** List the org's (non-archived) library, annotated with the caller's share. */
router.get("/", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const rows = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.organizationId, orgUuid), eq(contentItems.isArchived, false)))
    .orderBy(desc(contentItems.createdAt))
    .all();

  const out = [];
  for (const ct of rows) {
    const mine = await db
      .select()
      .from(contentShares)
      .where(and(eq(contentShares.contentId, ct.id), eq(contentShares.sharedByUserId, user.userId)))
      .limit(1)
      .get();
    out.push(
      contentResponse(ct, await shareCount(db, ct.id), mine ? await buildMyShare(db, c.var.settings, mine) : null),
    );
  }
  return c.json(out);
});

/** Add an item to the library (admin only). */
router.post("/", async (c) => {
  const user = await requireOrgAdmin(c);
  const data = await parseJson(c, ContentCreate);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);

  let fileUuid: string | null = null;
  if (data.kind === CONTENT_KIND_LINK) {
    if (!data.canonical_url) httpError(400, "Link content needs a canonical_url.");
  } else if (data.kind === CONTENT_KIND_FILE) {
    if (!data.file_id) httpError(400, "File content needs a file_id.");
    fileUuid = pyUuid(data.file_id);
    if (!fileUuid) httpError(400, "Invalid file_id.");
    const owned = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(
        and(eq(fileAssets.id, fileUuid), eq(fileAssets.userId, user.userId), eq(fileAssets.status, FILE_STATUS_ACTIVE)),
      )
      .get();
    if (!owned) httpError(400, "File not found, not yours, or not active.");
  }

  const now = nowIso();
  const content = (await db
    .insert(contentItems)
    .values({
      id: crypto.randomUUID(),
      organizationId: orgUuid,
      createdByUserId: user.userId,
      title: data.title,
      description: data.description ?? null,
      kind: data.kind,
      canonicalUrl: data.canonical_url ?? null,
      fileId: fileUuid,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()) as Content;
  return c.json(contentResponse(content, 0, null), 201);
});

/**
 * Add a ChampVault asset to the library as a live reference (admin only).
 *
 * Idempotent per (org, asset): re-adding the same asset returns the existing
 * library item. The item shares like any other content, and each member share
 * re-mints a fresh ChampVault delivery URL on open (perpetual beams).
 */
router.post("/from-champvault", async (c) => {
  const user = await requireOrgAdmin(c);
  const data = await parseJson(c, ChampVaultAddRequest);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);

  let title = (data.title ?? "").trim();
  let description = data.description ?? null;
  // Resolve title/description from ChampVault when the admin didn't supply them.
  if (!title) {
    let asset;
    try {
      asset = await new ChampVault(c.var.settings).getAsset(data.asset_id);
    } catch (err) {
      if (err instanceof ChampVaultNotConfigured) httpError(503, "ChampVault is not configured.");
      httpError(502, `ChampVault error: ${(err as Error).message}`);
    }
    title = asset.title || `ChampVault asset ${data.asset_id}`;
    if (data.description == null) description = asset.description;
  }

  const content = await getOrCreateChampvaultContent(db, orgUuid, data.asset_id, {
    title,
    description,
    createdByUserId: user.userId,
  });
  return c.json(contentResponse(content, await shareCount(db, content.id), null), 201);
});

router.patch("/:content_id", async (c) => {
  const user = await requireOrgAdmin(c);
  const data = await parseJson(c, ContentUpdate);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const content = await getOrgContent(db, c.req.param("content_id"), orgUuid);
  const patch: Partial<Content> = {};
  if (data.title != null) patch.title = data.title;
  if (data.description != null) patch.description = data.description;
  if (data.is_archived != null) patch.isArchived = data.is_archived;
  if (Object.keys(patch).length) {
    patch.updatedAt = nowIso();
    await db.update(contentItems).set(patch).where(eq(contentItems.id, content.id));
    Object.assign(content, patch);
  }
  return c.json(contentResponse(content, await shareCount(db, content.id), null));
});

/** Delete a library item and its share records (members' links/files remain). */
router.delete("/:content_id", async (c) => {
  const user = await requireOrgAdmin(c);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const content = await getOrgContent(db, c.req.param("content_id"), orgUuid);
  // content_shares cascade via FK; delete them explicitly too so this never
  // depends on PRAGMA foreign_keys.
  await db.batch([
    db.delete(contentShares).where(eq(contentShares.contentId, content.id)),
    db.delete(contentItems).where(eq(contentItems.id, content.id)),
  ]);
  return c.body(null, 204);
});

/**
 * Share a library item: mints the caller's own link/file and records it.
 *
 * The body is optional and parsed permissively ({"domain_id": ...} when
 * present) — integration clients POST empty or oddly-typed bodies (e.g.
 * curl -d '{}' sends form-urlencoded), and none of that should matter.
 */
router.post("/:content_id/share", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const content = await getOrgContent(db, c.req.param("content_id"), orgUuid);
  if (content.isArchived) httpError(409, "This content is archived.");
  let domainId: string | null = null;
  try {
    const raw = await c.req.text();
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const v = (parsed as Record<string, unknown>).domain_id;
        domainId = v == null || v === "" ? null : String(v);
      }
    }
  } catch {
    // any unparseable body just means "no options"
  }
  const { share, shareUrl } = await mintShare(db, c.var.settings, content, user.userId, domainId);
  return c.json({ share_id: share.id, content_id: content.id, share_url: shareUrl }, 201);
});

/** The caller's shares across the org library, with each share's open count. */
router.get("/mine/shares", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const orgUuid = await orgUuidForUser(db, user);
  const rows = await db
    .select({ content: contentItems, share: contentShares })
    .from(contentItems)
    .innerJoin(contentShares, eq(contentShares.contentId, contentItems.id))
    .where(and(eq(contentItems.organizationId, orgUuid), eq(contentShares.sharedByUserId, user.userId)))
    .orderBy(desc(contentShares.createdAt))
    .all();
  const out = [];
  for (const { content, share } of rows) {
    out.push(contentResponse(content, 0, await buildMyShare(db, c.var.settings, share)));
  }
  return c.json(out);
});
