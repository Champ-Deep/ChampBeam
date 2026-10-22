/** Port of backend/app/services/org_service.py (Clerk Orgs -> local mirror). */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { ROLE_MEMBER, organizationMemberships, organizations } from "../db/schema";
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
  return (m.role ?? "").toLowerCase().endsWith("admin");
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
  const patch: Partial<Membership> = { role, updatedAt: nowIso() };
  if (clerkMembershipId) patch.clerkMembershipId = clerkMembershipId;
  await db.update(organizationMemberships).set(patch).where(eq(organizationMemberships.id, existing.id));
  return { ...existing, ...patch };
}

// (user_id, clerk_org_id) -> [role, ts]. Per-isolate throttle like the Python TTL cache.
const syncCache = new Map<string, [string, number]>();
const SYNC_TTL_MS = 300_000;

/** Best-effort mirror of the active org membership from token claims. Never throws. */
export async function syncFromToken(
  db: Db,
  userId: string,
  clerkOrgId: string,
  role: string,
  slug?: string | null,
): Promise<void> {
  const key = `${userId}|${clerkOrgId}`;
  const cached = syncCache.get(key);
  const now = Date.now();
  if (cached && cached[0] === role && now - cached[1] < SYNC_TTL_MS) return;
  try {
    const org = await upsertOrganization(db, clerkOrgId, { slug });
    await upsertMembership(db, org.id, userId, role);
    syncCache.set(key, [role, now]);
  } catch (err) {
    console.warn(`org sync_from_token failed for org=${clerkOrgId}`, err);
  }
}

/** Test hook: forget throttled syncs. */
export function _resetSyncCache(): void {
  syncCache.clear();
}

export async function getMembership(db: Db, userId: string, clerkOrgId: string): Promise<Membership | undefined> {
  const row = await db
    .select({ m: organizationMemberships })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
    .where(and(eq(organizations.clerkOrgId, clerkOrgId), eq(organizationMemberships.userId, userId)))
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
