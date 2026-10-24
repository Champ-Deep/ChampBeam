/**
 * Host-aware file-asset lookup shared by the public serve router
 * (routes/filesServe.ts) and Beam State (services/pageState.ts). Port of the
 * private helpers `_request_host`, `_resolve_domain`, `_lookup_asset` in
 * backend/app/api/files.py.
 *
 * Exports:
 *   requestHost(c): string                                   (re-export of lib/request)
 *   resolveDomain(db, settings, host): Promise<Domain | null>
 *   lookupAsset(db, domain, { shortCode } | { slug }): Promise<FileAsset | null>
 *   resolveHost(c | {db, settings, host}): Promise<{ host, domain, unknownHost }>
 *   types FileAsset, Domain
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Context } from "hono";
import type { AppEnv, Settings } from "../env";
import type { Db } from "../db/client";
import { DOMAIN_STATUS_ACTIVE, FILE_STATUS_ACTIVE, domains, fileAssets, slugAliases } from "../db/schema";
import { requestHost } from "../lib/request";

export { requestHost };

export type FileAsset = typeof fileAssets.$inferSelect;
export type Domain = typeof domains.$inferSelect;

/** Active custom domain for `host`; null for the platform host(s) or an unknown host. */
export async function resolveDomain(db: Db, settings: Settings, host: string): Promise<Domain | null> {
  if (!host || settings.isPlatformHost(host)) return null;
  const rows = await db
    .select()
    .from(domains)
    .where(and(eq(domains.hostname, host), eq(domains.status, DOMAIN_STATUS_ACTIVE)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Find the active asset for `shortCode` OR `slug` in the host's namespace.
 *
 * Platform host -> `domain_id IS NULL`. A custom domain serves its owner's
 * whole library: assets explicitly assigned to this domain AND the owner's
 * platform-bucket assets (domain_id NULL), because serve URLs are minted on
 * the user's PRIMARY domain even for assets created before that domain
 * existed. Exact domain match wins when both buckets hold the same code.
 */
export async function lookupAsset(
  db: Db,
  domain: Pick<Domain, "id" | "userId" | "organizationId"> | null,
  ident: { shortCode: string; slug?: undefined } | { slug: string; shortCode?: undefined },
): Promise<FileAsset | null> {
  const hasCode = ident.shortCode != null;
  const hasSlug = ident.slug != null;
  if (hasCode === hasSlug) throw new Error("pass exactly one of shortCode / slug");
  const identCond = hasCode ? eq(fileAssets.shortCode, ident.shortCode!) : eq(fileAssets.slug, ident.slug!);
  const base = and(identCond, eq(fileAssets.status, FILE_STATUS_ACTIVE));
  if (domain === null) {
    const rows = await db.select().from(fileAssets).where(and(base, isNull(fileAssets.domainId))).limit(1);
    return rows[0] ?? (hasSlug ? aliasTarget(db, ident.slug!, null) : null);
  }
  const rows = await db
    .select()
    .from(fileAssets)
    .where(
      and(
        base,
        or(
          eq(fileAssets.domainId, domain.id),
          // An org domain serves only what was shared on it; the admin who connected it
          // must not expose their personal platform-bucket assets through it.
          domain.organizationId ? sql`0` : and(eq(fileAssets.userId, domain.userId), isNull(fileAssets.domainId)),
        ),
      ),
    )
    // CASE instead of `(domain_id = ?) DESC`: the comparison is NULL for the
    // platform bucket, and NULL ordering differs between engines.
    .orderBy(sql`CASE WHEN ${fileAssets.domainId} = ${domain.id} THEN 1 ELSE 0 END DESC`)
    .limit(1);
  return rows[0] ?? (hasSlug ? aliasTarget(db, ident.slug!, domain.id) : null);
}

/** A retired slug (explicitly renamed page) still resolves to its page in the same host namespace. */
async function aliasTarget(db: Db, slug: string, domainId: string | null): Promise<FileAsset | null> {
  const row = await db
    .select({ asset: fileAssets })
    .from(slugAliases)
    .innerJoin(fileAssets, eq(fileAssets.id, slugAliases.fileId))
    .where(
      and(
        eq(slugAliases.slug, slug),
        domainId === null ? isNull(slugAliases.domainId) : eq(slugAliases.domainId, domainId),
        eq(fileAssets.status, FILE_STATUS_ACTIVE),
      ),
    )
    .limit(1)
    .get();
  return row?.asset ?? null;
}

export interface HostContext {
  host: string;
  domain: Domain | null;
  /**
   * A custom hostname that isn't registered or isn't active. Every public
   * handler refuses these (404) rather than fall through to the platform bucket:
   * `if (host && domain is None and not settings.is_platform_host(host))`.
   */
  unknownHost: boolean;
}

/** The host/domain preamble every public serve handler repeats. */
export async function resolveHost(
  src: Context<AppEnv> | { db: Db; settings: Settings; host: string },
): Promise<HostContext> {
  let db: Db, settings: Settings, host: string;
  if ("req" in src) {
    db = src.var.db;
    settings = src.var.settings;
    host = requestHost(src);
  } else {
    ({ db, settings, host } = src);
  }
  const domain = await resolveDomain(db, settings, host);
  return { host, domain, unknownHost: !!host && domain === null && !settings.isPlatformHost(host) };
}
