/**
 * Domain authorization and defaults. One place decides which hosts a user may
 * mint shares on, so a request body naming another tenant's domain id is
 * rejected the same way on every create path (files, pages, links, content).
 *
 * A domain is usable when it is ACTIVE (ownership + TLS verified) and either
 *   - personal: owned by the caller, or
 *   - org-authorized: organization_id equals the caller's active org AND the
 *     caller's role may share (a viewer-only seat may not).
 * Unverified domains never produce working-looking URLs.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { can, type TokenData } from "../auth/security";
import type { Db } from "../db/client";
import { DOMAIN_STATUS_ACTIVE, domains } from "../db/schema";
import type { Settings } from "../env";

export type Domain = typeof domains.$inferSelect;

/** The active org uuid the caller may share under, else null (personal only). */
export const shareOrgUuid = (u: Pick<TokenData, "orgId" | "orgRole" | "orgUuid">): string | null =>
  u.orgUuid && can(u as TokenData, "share.create") ? u.orgUuid : null;

export async function findUsableDomain(
  db: Db,
  userId: string,
  orgUuid: string | null,
  domainId: string,
): Promise<Domain | null> {
  const owner = orgUuid
    ? or(eq(domains.userId, userId), eq(domains.organizationId, orgUuid))
    : eq(domains.userId, userId);
  const d = await db
    .select()
    .from(domains)
    .where(and(eq(domains.id, domainId), eq(domains.status, DOMAIN_STATUS_ACTIVE), owner))
    .get();
  // A personal-looking row that belongs to an org is only usable via that org.
  if (d && d.organizationId && d.organizationId !== orgUuid) return null;
  return d ?? null;
}

/**
 * Default host for new shares: org default (when the caller shares under an
 * org) -> the caller's own primary -> null (= platform share host).
 */
export async function defaultDomainFor(db: Db, u: TokenData): Promise<Domain | null> {
  const org = shareOrgUuid(u);
  if (org) {
    const d = await db
      .select()
      .from(domains)
      .where(and(eq(domains.organizationId, org), eq(domains.isOrgDefault, true), eq(domains.status, DOMAIN_STATUS_ACTIVE)))
      .get();
    if (d) return d;
  }
  // Only a personal primary: an org domain the user administers is not personal.
  const p = await db
    .select()
    .from(domains)
    .where(
      and(
        eq(domains.userId, u.userId),
        eq(domains.isPrimary, true),
        eq(domains.status, DOMAIN_STATUS_ACTIVE),
        isNull(domains.organizationId),
      ),
    )
    .get();
  return p ?? null;
}

/** Hosts a user may choose from: active personal + active org-authorized. */
export async function availableDomains(db: Db, u: TokenData): Promise<Domain[]> {
  const org = shareOrgUuid(u);
  const mine = await db
    .select()
    .from(domains)
    .where(and(eq(domains.status, DOMAIN_STATUS_ACTIVE), org ? or(eq(domains.userId, u.userId), eq(domains.organizationId, org)) : eq(domains.userId, u.userId)))
    .all();
  return mine.filter((d) => !d.organizationId || d.organizationId === org);
}

/** The host new shares use when no domain is chosen. */
export function platformShareHost(settings: Settings): string {
  return settings.resolvedShareHost || settings.resolvedPlatformRedirectHost || "localhost:8000";
}
