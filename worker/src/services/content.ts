/**
 * Shared-content-library orchestration. Port of backend/app/services/content_service.py.
 *
 * The interesting bit is `mintShare`: when a member shares a library item we
 * give them their *own* trackable link/file (own short code, optionally on
 * their own domain) and record a ContentShare stamping the canonical
 * content_id. Different members sharing the same content thus produce distinct
 * links/files that still roll up to one content item in the admin's analytics.
 *
 * Errors are thrown as HTTPError (lib/errors) with the Python detail strings.
 *
 * Exports (Python name -> TS):
 *   types Content, ContentShare, Domain
 *   shortCode(n = 8): string                                         (_short_code)
 *   schemeFor(host: string): "http" | "https"                        (_scheme_for)
 *   safeSlug(filename: string): string                               (_safe_slug)
 *   resolveMemberDomain(db: Db, userId: string, domainId: string | null | undefined): Promise<Domain | null>   (_resolve_member_domain; 400s)
 *   allocateFileShortCode(db: Db, domainId: string | null): Promise<string>   (_allocate_file_short_code; 503 when exhausted)
 *   platformHost(settings: Settings): string                         (_platform_host)
 *   buildShareUrl(settings: Settings, { link, file, hostname }): string
 *   mintShare(db: Db, settings: Settings, content: Content, memberUserId: string, domainId?: string | null,
 *             opts?: { champvaultDeliveryUrl?: string | null }): Promise<{ share: ContentShare; shareUrl: string }>
 *   getChampvaultContent(db: Db, orgId: string, assetId: string): Promise<Content | null>
 *   getOrCreateChampvaultContent(db: Db, orgId: string, assetId: string,
 *             { title, description, createdByUserId }): Promise<Content>
 */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  CONTENT_KIND_FILE,
  CONTENT_KIND_LINK,
  DOMAIN_STATUS_ACTIVE,
  FILE_STATUS_ACTIVE,
  contentItems,
  contentShares,
  domains,
  fileAssets,
  linkClicks,
} from "../db/schema";
import type { Settings } from "../env";
import { randomString } from "../lib/crypto";
import { httpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { findUsableDomain } from "./domains";
import { type FileAsset, type LinkClick, recordLink } from "./utm";

export type Content = typeof contentItems.$inferSelect;
export type ContentShare = typeof contentShares.$inferSelect;
export type Domain = typeof domains.$inferSelect;

const ALPHANUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function shortCode(n = 8): string {
  return randomString(n, ALPHANUM);
}

export function schemeFor(host: string): "http" | "https" {
  return host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https";
}

export function safeSlug(filename: string): string {
  // Python's str.isalnum() is Unicode-aware; \p{L}\p{N} matches that.
  return Array.from(filename)
    .map((c) => (/^[\p{L}\p{N}]$/u.test(c) || ".-_".includes(c) ? c : "_"))
    .join("")
    .slice(0, 80);
}

/** Python `UUID(value)` accepts hyphenless/braced/urn forms; normalize to canonical lowercase. */
function normalizeUuid(value: string): string | null {
  let v = value.trim().toLowerCase();
  if (v.startsWith("urn:uuid:")) v = v.slice(9);
  v = v.replace(/^\{|\}$/g, "").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(v)) return null;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

/** A member's chosen active domain, or null (platform default). 400 if bad. */
export async function resolveMemberDomain(
  db: Db,
  userId: string,
  domainId: string | null | undefined,
  /** The caller's active org (only when their role may share): lets them pick that org's domains. */
  orgUuid: string | null = null,
): Promise<Domain | null> {
  if (!domainId) return null;
  const did = normalizeUuid(domainId);
  if (!did) httpError(400, "Invalid domain_id.");
  const domain = await findUsableDomain(db, userId, orgUuid, did);
  if (!domain) httpError(400, "Domain not found, not yours, or not active.");
  return domain;
}

export async function allocateFileShortCode(db: Db, domainId: string | null): Promise<string> {
  for (let i = 0; i < 8; i++) {
    const code = shortCode();
    const hit = await db
      .select({ id: fileAssets.id })
      .from(fileAssets)
      .where(
        and(
          eq(fileAssets.shortCode, code),
          domainId == null ? isNull(fileAssets.domainId) : eq(fileAssets.domainId, domainId),
        ),
      )
      .get();
    if (!hit) return code;
  }
  httpError(503, "Could not allocate a unique short code.");
}

export function platformHost(settings: Settings): string {
  return settings.resolvedPlatformRedirectHost || "localhost:8000";
}

export function buildShareUrl(
  settings: Settings,
  {
    link,
    file,
    hostname,
  }: {
    link?: Pick<LinkClick, "shortCode"> | null;
    file?: Pick<FileAsset, "shortCode" | "filename"> | null;
    hostname?: string | null;
  },
): string {
  const host = hostname || platformHost(settings);
  const scheme = schemeFor(host);
  if (link) return `${scheme}://${host}/r/${link.shortCode}`;
  if (!file) throw new Error("buildShareUrl needs a link or a file");
  return `${scheme}://${host}/f/${file.shortCode}/${safeSlug(file.filename)}`;
}

/**
 * Create (or reuse) a member's link/file for `content` and record a share.
 * Re-sharing the same item on the same domain reuses the existing link/file so
 * a member ends up with one stable URL per item.
 *
 * For ChampVault-backed content the caller passes `champvaultDeliveryUrl` — a
 * freshly-minted delivery URL used as the link's fallback tracked_url; the link
 * is stamped with the asset id so the redirect re-mints on each open.
 */
export async function mintShare(
  db: Db,
  settings: Settings,
  content: Content,
  memberUserId: string,
  domainId: string | null = null,
  opts: { champvaultDeliveryUrl?: string | null } = {},
): Promise<{ share: ContentShare; shareUrl: string }> {
  const delivery = opts.champvaultDeliveryUrl ?? null;
  const domain = await resolveMemberDomain(db, memberUserId, domainId, content.organizationId);
  const domainUuid = domain ? domain.id : null;
  const hostname = domain ? domain.hostname : platformHost(settings);

  // Idempotent: one share per (content, member, domain).
  const existing = await existingShare(db, content, memberUserId, domainUuid);
  if (existing) {
    const link = existing.linkId
      ? ((await db.select().from(linkClicks).where(eq(linkClicks.id, existing.linkId)).get()) ?? null)
      : null;
    const file = existing.fileId
      ? ((await db.select().from(fileAssets).where(eq(fileAssets.id, existing.fileId)).get()) ?? null)
      : null;
    // Refresh the fallback URL on a ChampVault re-send so a stale delivery URL
    // never lingers if the redirect-time re-mint is unavailable.
    if (link && delivery) {
      await db.update(linkClicks).set({ trackedUrl: delivery }).where(eq(linkClicks.id, link.id)).run();
      link.trackedUrl = delivery;
    }
    return { share: existing, shareUrl: buildShareUrl(settings, { link, file, hostname }) };
  }

  if (content.kind === CONTENT_KIND_LINK) {
    if (!content.canonicalUrl) httpError(400, "This content has no link to share.");
    const link = await recordLink(db, {
      userId: memberUserId,
      originalUrl: content.canonicalUrl,
      trackedUrl: delivery || content.canonicalUrl,
      utmParams: {},
      domainId: domainUuid,
    });
    const share = newShare(content, memberUserId, { linkId: link.id, domainId: domainUuid });
    if (content.champvaultAssetId) {
      await db.batch([
        db.update(linkClicks).set({ champvaultAssetId: content.champvaultAssetId }).where(eq(linkClicks.id, link.id)),
        db.insert(contentShares).values(share),
      ]);
      link.champvaultAssetId = content.champvaultAssetId;
    } else {
      await db.insert(contentShares).values(share).run();
    }
    return { share, shareUrl: buildShareUrl(settings, { link, hostname }) };
  }

  if (content.kind === CONTENT_KIND_FILE) {
    const master = await loadMasterFile(db, content);
    const code = await allocateFileShortCode(db, domainUuid);
    const copy: FileAsset = {
      ...master,
      id: crypto.randomUUID(),
      userId: memberUserId,
      domainId: domainUuid,
      shortCode: code,
      slug: null,
      status: FILE_STATUS_ACTIVE,
      viewCount: 0,
      lastViewedAt: null,
      createdAt: nowIso(),
      expiresAt: null,
      maxViews: null,
      revokedAt: null,
      requireEmail: false,
      blockVpn: false,
      branded: false,
      ownerTokenHash: null,
      stateToken: null,
      accessCodeHash: null,
      projectId: null,
      // shares the bytes (storage_key) — no re-upload
    };
    const share = newShare(content, memberUserId, { fileId: copy.id, domainId: domainUuid });
    await db.batch([db.insert(fileAssets).values(copy), db.insert(contentShares).values(share)]);
    return { share, shareUrl: buildShareUrl(settings, { file: copy, hostname }) };
  }

  httpError(400, `Unsupported content kind '${content.kind}'.`);
}

/** The org's shadow library row for a ChampVault asset, if one exists. */
export async function getChampvaultContent(db: Db, orgId: string, assetId: string): Promise<Content | null> {
  const row = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.organizationId, orgId), eq(contentItems.champvaultAssetId, assetId)))
    .get();
  return row ?? null;
}

/**
 * Idempotently get/create the org's shadow Content for a ChampVault asset.
 * canonical_url holds the `champvault://` marker (never a real destination).
 */
export async function getOrCreateChampvaultContent(
  db: Db,
  orgId: string,
  assetId: string,
  {
    title,
    description,
    createdByUserId,
  }: { title: string | null | undefined; description: string | null | undefined; createdByUserId: string | null | undefined },
): Promise<Content> {
  const existing = await getChampvaultContent(db, orgId, assetId);
  if (existing) return existing;
  const now = nowIso();
  return (await db
    .insert(contentItems)
    .values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      createdByUserId: createdByUserId || null,
      title: title || `ChampVault asset ${assetId}`,
      description: description ?? null,
      kind: CONTENT_KIND_LINK,
      canonicalUrl: `champvault://${assetId}`,
      champvaultAssetId: assetId,
      isArchived: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get()) as Content;
}

async function loadMasterFile(db: Db, content: Content): Promise<FileAsset> {
  if (!content.fileId) httpError(400, "This content has no file to share.");
  const master = await db.select().from(fileAssets).where(eq(fileAssets.id, content.fileId)).get();
  if (!master || master.status !== FILE_STATUS_ACTIVE) httpError(409, "The source file is not available.");
  return master;
}

/** The member's existing share of this content on this domain, if any. */
async function existingShare(
  db: Db,
  content: Content,
  memberUserId: string,
  domainUuid: string | null,
): Promise<ContentShare | null> {
  const row = await db
    .select()
    .from(contentShares)
    .where(
      and(
        eq(contentShares.contentId, content.id),
        eq(contentShares.sharedByUserId, memberUserId),
        domainUuid == null ? isNull(contentShares.domainId) : eq(contentShares.domainId, domainUuid),
      ),
    )
    .get();
  return row ?? null;
}

function newShare(
  content: Content,
  memberUserId: string,
  { linkId = null, fileId = null, domainId = null }: { linkId?: string | null; fileId?: string | null; domainId?: string | null },
): ContentShare {
  return {
    id: crypto.randomUUID(),
    contentId: content.id,
    organizationId: content.organizationId,
    sharedByUserId: memberUserId,
    linkId,
    fileId,
    domainId,
    createdAt: nowIso(),
  };
}
