/**
 * Who may read reporting, and for whom. Scope is recomputed from D1 on every
 * request (membership tombstone + grant revocation take effect immediately,
 * even for a still-valid session token). Nothing here grants a write right.
 *
 *   org admin            -> whole org   (report.org)
 *   org-scope grant      -> whole org   (read only)
 *   leader               -> self + reps (report.team)
 *   team-scope grant     -> that leader + their reps
 *   member               -> self        (report.own)
 *   viewer role, no grant-> nothing
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { can, type TokenData } from "../auth/security";
import type { Db } from "../db/client";
import { MEMBERSHIP_ACTIVE, organizationMemberships, reportingGrants } from "../db/schema";

export interface ReportScope {
  kind: "org" | "team" | "own" | "none";
  /** null = every member of the org; otherwise the user ids the caller may see. */
  userIds: Set<string> | null;
}

/** A leader plus their active reps. */
export async function teamOf(db: Db, orgUuid: string, leaderIds: string[]): Promise<Set<string>> {
  const ids = new Set(leaderIds);
  if (!leaderIds.length) return ids;
  const reps = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.organizationId, orgUuid),
        eq(organizationMemberships.status, MEMBERSHIP_ACTIVE),
        inArray(organizationMemberships.leaderUserId, leaderIds),
      ),
    )
    .all();
  for (const r of reps) ids.add(r.userId);
  return ids;
}

export async function activeGrants(db: Db, orgUuid: string, userId?: string) {
  const where = [eq(reportingGrants.organizationId, orgUuid), isNull(reportingGrants.revokedAt)];
  if (userId) where.push(eq(reportingGrants.userId, userId));
  return db.select().from(reportingGrants).where(and(...where)).all();
}

export async function reportScope(db: Db, u: TokenData): Promise<ReportScope> {
  const org = u.orgUuid;
  if (!org) return { kind: "none", userIds: new Set() };
  if (can(u, "report.org")) return { kind: "org", userIds: null };
  const grants = await activeGrants(db, org, u.userId);
  if (grants.some((g) => g.scope === "org")) return { kind: "org", userIds: null };

  const leaders = grants.filter((g) => g.scope === "team").map((g) => g.leaderUserId!);
  if (can(u, "team.manage")) leaders.push(u.userId);
  const ids = leaders.length ? await teamOf(db, org, leaders) : new Set<string>();
  if (can(u, "report.own")) ids.add(u.userId);
  if (leaders.length) return { kind: "team", userIds: ids };
  return { kind: ids.size ? "own" : "none", userIds: ids };
}
