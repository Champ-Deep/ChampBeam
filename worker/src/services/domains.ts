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
import { httpError } from "../lib/errors";
import { reachableShareHost } from "../lib/shareOriginLive";

export type Domain = typeof domains.$inferSelect;

/** The active org uuid the caller may share under, else null (personal only). */
export const shareOrgUuid = (u: Pick<TokenData, "orgId" | "orgRole" | "orgUuid">): string | null =>
  u.orgUuid && can(u as TokenData, "share.create") ? u.orgUuid : null;

/**
 * Creating a share needs share.create when the caller is acting inside an org.
 * Without this, a viewer silently fell back to a personal (org-less) share.
 */
export function assertCanShare(u: Pick<TokenData, "orgId" | "orgRole" | "orgUuid">): void {
  if (u.orgUuid && !can(u as TokenData, "share.create")) httpError(403, "Your role cannot create shares in this organization.");
}

/**
 * Editing an asset that already sits on an org domain needs the same authority as publishing there,
 * so a removed or viewer-demoted owner cannot keep rewriting content on the org's verified host.
 */
export async function assertDomainEditable(
  db: Db,
  u: Pick<TokenData, "orgId" | "orgRole" | "orgUuid">,
  domainId: string | null | undefined,
): Promise<void> {
  if (!domainId) return;
  const d = await db.select({ org: domains.organizationId }).from(domains).where(eq(domains.id, domainId)).get();
  if (d?.org && shareOrgUuid(u) !== d.org) httpError(403, "Only a current member who can share may edit content on this organization's domain.");
}

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

/**
 * Host new shares use when no domain is chosen. A configured share origin is
 * used only after it answers /health, so a name in SHARE_ORIGIN_HOSTS does not
 * become a link target before that custom domain exists.
 */
export async function platformShareHost(settings: Settings): Promise<string> {
  return (await reachableShareHost(settings)) || settings.resolvedPlatformRedirectHost || "localhost:8000";
}
