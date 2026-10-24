/** Port of backend/app/services/org_service.py (Clerk Orgs -> local mirror). */
import { and, eq, isNull } from "drizzle-orm";
import { roleHas } from "../auth/permissions";
import type { Db } from "../db/client";
import {
  MEMBERSHIP_ACTIVE,
  MEMBERSHIP_REVOKED,
  ROLE_MEMBER,
  organizationMemberships,
  organizations,
  reportingGrants,
} from "../db/schema";
import { nowIso } from "../lib/time";

export type Organization = typeof organizations.$inferSelect;
export type Membership = typeof organizationMemberships.$inferSelect;

/** Strip Clerk's `org:` prefix and lowercase. Defaults to 'member'. */
export function normalizeRole(raw: string | null | undefined): string {
  if (!raw) return ROLE_MEMBER;
  let r = raw.trim();
  if (r.startsWith("org:")) r = r.slice(4);
  return r.toLowerCase() || ROLE_MEMBER;
}

export function membershipIsAdmin(m: Pick<Membership, "role">): boolean {
  return roleHas(m.role, "org.members.manage");
}

export function membershipIsLeader(m: Pick<Membership, "role">): boolean {
  return (m.role ?? "").toLowerCase() === "leader";
}

export async function upsertOrganization(
  db: Db,
  clerkOrgId: string,
  opts: { name?: string | null; slug?: string | null } = {},
): Promise<Organization> {
  const existing = await db.select().from(organizations).where(eq(organizations.clerkOrgId, clerkOrgId)).get();
  if (!existing) {
    const now = nowIso();
    await db
      .insert(organizations)
      .values({
        id: crypto.randomUUID(),
        clerkOrgId,
        name: opts.name ?? null,
        slug: opts.slug ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return (await db.select().from(organizations).where(eq(organizations.clerkOrgId, clerkOrgId)).get())!;
  }
  const patch: Partial<Organization> = {};
  if (opts.name != null) patch.name = opts.name;
  if (opts.slug != null) patch.slug = opts.slug;
  if (Object.keys(patch).length) {
    patch.updatedAt = nowIso();
    await db.update(organizations).set(patch).where(eq(organizations.id, existing.id));
    Object.assign(existing, patch);
  }
  return existing;
}

export async function upsertMembership(
  db: Db,
  organizationId: string,
  userId: string,
  role: string,
  clerkMembershipId?: string | null,
): Promise<Membership> {
  const where = and(
    eq(organizationMemberships.organizationId, organizationId),
    eq(organizationMemberships.userId, userId),
  );
  const existing = await db.select().from(organizationMemberships).where(where).get();
  if (!existing) {
    const now = nowIso();
    await db
      .insert(organizationMemberships)
      .values({
        id: crypto.randomUUID(),
        organizationId,
        userId,
        role,
        clerkMembershipId: clerkMembershipId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    return (await db.select().from(organizationMemberships).where(where).get())!;
  }
  // Clerk (webhook) re-adding a member is the only thing that lifts a revocation.
  const patch: Partial<Membership> = { role, status: MEMBERSHIP_ACTIVE, revokedAt: null, updatedAt: nowIso() };
  if (clerkMembershipId) patch.clerkMembershipId = clerkMembershipId;
  await db.update(organizationMemberships).set(patch).where(eq(organizationMemberships.id, existing.id));
  return { ...existing, ...patch };
}

export interface ActiveMembership {
  /** Local organizations.id (UUID); null only if the mirror write failed. */
  orgUuid: string | null;
  role: string;
}

/**
 * The caller's effective membership for the org named in their session token,
 * re-read from the D1 mirror on every request (one indexed lookup).
 *
 * Policy (stale-session handling):
 *  - Revoked membership (Clerk webhook tombstone) -> null: no org access, even
 *    while the signed token is still inside its lifetime. Token claims can
 *    never revive it; only Clerk re-adding the member (webhook) can.
 *  - A webhook-managed row (has clerk_membership_id) is authoritative for the
 *    role, so a demotion takes effect before the old token expires.
 *  - Otherwise (webhook not configured, or first sight) the token role is used
 *    and mirrored: the original lazy-sync backstop.
 * Never throws: a mirror failure falls back to the token claim.
 */
export async function resolveActiveMembership(
  db: Db,
  userId: string,
  clerkOrgId: string,
  tokenRole: string,
  slug?: string | null,
): Promise<ActiveMembership | null> {
  try {
    const row = await db
      .select({ m: organizationMemberships, orgUuid: organizations.id })
      .from(organizationMemberships)
      .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
      .where(and(eq(organizations.clerkOrgId, clerkOrgId), eq(organizationMemberships.userId, userId)))
      .get();
    if (!row) {
      const org = await upsertOrganization(db, clerkOrgId, { slug });
      const m = await upsertMembership(db, org.id, userId, tokenRole);
      return { orgUuid: org.id, role: m.role };
    }
    if (row.m.status === MEMBERSHIP_REVOKED) return null;
    if (row.m.clerkMembershipId) return { orgUuid: row.orgUuid, role: row.m.role };
    if (row.m.role !== tokenRole) await upsertMembership(db, row.m.organizationId, userId, tokenRole);
    return { orgUuid: row.orgUuid, role: tokenRole };
  } catch (err) {
    console.warn(`org membership resolve failed for org=${clerkOrgId}`, err);
    return { orgUuid: null, role: tokenRole };
  }
}

/** Tombstone a membership and end the member's reporting grants (Clerk removed them). */
export async function revokeMembership(db: Db, organizationId: string, userId: string): Promise<void> {
  const now = nowIso();
  await db
    .update(organizationMemberships)
    .set({ status: MEMBERSHIP_REVOKED, revokedAt: now, updatedAt: now })
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
  await db
    .update(reportingGrants)
    .set({ revokedAt: now })
    .where(
      and(
        eq(reportingGrants.organizationId, organizationId),
        eq(reportingGrants.userId, userId),
        isNull(reportingGrants.revokedAt),
      ),
    );
}

/** Active membership of `userId` in the org, or undefined (revoked rows do not count). */
export async function getActiveMembershipRow(db: Db, organizationId: string, userId: string) {
  return db
    .select()
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, organizationId),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, MEMBERSHIP_ACTIVE),
      ),
    )
    .get();
}

export async function getMembership(db: Db, userId: string, clerkOrgId: string): Promise<Membership | undefined> {
  const row = await db
    .select({ m: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
    .where(
      and(
        eq(organizations.clerkOrgId, clerkOrgId),
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.status, MEMBERSHIP_ACTIVE),
      ),
    )
    .get();
  return row?.m;
}

/** Local Organization UUID for a Clerk org id, or null. */
export async function resolveOrgUuid(db: Db, clerkOrgId: string): Promise<string | null> {
  const row = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.clerkOrgId, clerkOrgId))
    .get();
  return row?.id ?? null;
}
