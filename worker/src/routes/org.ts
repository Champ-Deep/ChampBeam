/**
 * Port of backend/app/api/v1/org.py — mounted at /api/v1/org.
 *
 * Organization endpoints: context, member roster, and consolidated analytics.
 *
 * The admin (marketing) sees how content performs across every member (sales
 * rep) in the org. Engagement is rolled up by `content_id` so the same content
 * shared by different members via different links/files is recognized as one
 * item and its stats are consolidated.
 *
 * Role tiers: a super admin (role ending in "admin") sees the whole org; a
 * leader sees only the reps assigned to them (+ their own activity); a plain
 * member sees no team analytics.
 */
import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import {
  type TokenData,
  isOrgAdmin,
  requireOrgAdmin,
  requireOrgLeaderOrAdmin,
  requireOrgMember,
} from "../auth/security";
import { chunk, type Db } from "../db/client";
import { assignments, contentItems, contentShares, organizationMemberships } from "../db/schema";
import { httpError } from "../lib/errors";
import { isoUtc, nowIso } from "../lib/time";
import { parseJson } from "../lib/validate";
import { membershipIsAdmin, membershipIsLeader } from "../services/org";
import { type Organization, isPlaceholderEmail, orgForUser, pyUuid } from "./_org";

export const router = new Hono<AppEnv>({ strict: false });

type Assignment = typeof assignments.$inferSelect;

// ============================================================================
// Schemas
// ============================================================================

const MemberUpdate = z.object({
  // The leader this member reports to. Send an empty string / null to clear.
  leader_user_id: z.string().nullish(),
});

const AssignmentCreate = z.object({
  champvault_asset_id: z.string(),
  asset_title: z.string().nullish(),
  assigned_to_user_id: z.string(),
  note: z.string().nullish(),
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * UNION ALL of (cid, member, ip, eid, at) engagement rows, bound to ?1 = org id.
 *
 * Combines link clicks and file views attributed through `content_shares` so a
 * single subquery can be grouped by content, by member, or by both — and
 * distinct-IP counts stay correct across a content's link and file shares.
 */
const ENGAGEMENT = `(
  SELECT cs.content_id AS cid, cs.shared_by_user_id AS member, ce.ip_address AS ip, ce.id AS eid, ce.clicked_at AS at
    FROM content_shares cs JOIN click_events ce ON ce.link_id = cs.link_id
   WHERE cs.organization_id = ?1 AND cs.link_id IS NOT NULL
  UNION ALL
  SELECT cs.content_id AS cid, cs.shared_by_user_id AS member, ce.ip_address AS ip, ce.id AS eid, ce.clicked_at AS at
    FROM content_shares cs JOIN click_events ce ON ce.file_id = cs.file_id
   WHERE cs.organization_id = ?1 AND cs.file_id IS NOT NULL
) eng`;

/**
 * Who the caller may see in analytics. `null` = the whole org (super admin).
 * A leader sees only the reps assigned to them plus their own activity.
 */
interface Visible {
  leaderId: string;
  ids: Set<string>;
}

async function visibleMembers(db: Db, org: Organization, user: TokenData): Promise<Visible | null> {
  if (isOrgAdmin(user)) return null;
  const reps = await db
    .select({ userId: organizationMemberships.userId })
    .from(organizationMemberships)
    .where(
      and(eq(organizationMemberships.organizationId, org.id), eq(organizationMemberships.leaderUserId, user.userId)),
    )
    .all();
  return { leaderId: user.userId, ids: new Set([user.userId, ...reps.map((r) => r.userId)]) };
}

/**
 * SQL condition restricting `col` to the visible members, using ?1 = org id and
 * ?2 = leader id (a subquery, so no bound-parameter limit concerns).
 */
const visibleSql = (col: string) =>
  `(${col} = ?2 OR ${col} IN (SELECT user_id FROM organization_memberships WHERE organization_id = ?1 AND leader_user_id = ?2))`;

function bindVisible(stmt: D1PreparedStatement, orgId: string, visible: Visible | null): D1PreparedStatement {
  return visible ? stmt.bind(orgId, visible.leaderId) : stmt.bind(orgId);
}

const int = (v: unknown) => Number(v ?? 0) || 0;

// Stable sort, descending by key (Python's list.sort(key=..., reverse=True)).
function sortDesc<T>(items: T[], key: (t: T) => number): T[] {
  return items
    .map((v, i) => [v, i] as const)
    .sort((a, b) => key(b[0]) - key(a[0]) || a[1] - b[1])
    .map(([v]) => v);
}

// ============================================================================
// Endpoints
// ============================================================================

/** The active org for the signed-in user, plus role and member count. */
router.get("/context", async (c) => {
  const user = await requireOrgMember(c);
  const org = await orgForUser(c.var.db, user);
  const row = await c.env.DB.prepare("SELECT COUNT(id) AS n FROM organization_memberships WHERE organization_id = ?1")
    .bind(org.id)
    .first<{ n: number }>();
  return c.json({
    org_id: user.orgId,
    org_slug: user.orgSlug || org.slug,
    name: org.name,
    role: user.orgRole ?? null,
    is_admin: isOrgAdmin(user),
    member_count: int(row?.n),
  });
});

/** Roster with sharing activity. Super admin sees all; a leader sees their reps. */
router.get("/members", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const visible = await visibleMembers(db, org, user);

  const { results: memberRows } = await c.env.DB.prepare(
    `SELECT m.role, m.leader_user_id, u.id AS user_id, u.email, u.full_name
       FROM organization_memberships m JOIN users u ON m.user_id = u.id
      WHERE m.organization_id = ?1`,
  )
    .bind(org.id)
    .all<{ role: string; leader_user_id: string | null; user_id: string; email: string | null; full_name: string | null }>();
  const members = visible ? memberRows.filter((m) => visible.ids.has(m.user_id)) : memberRows;

  // Shares per member.
  const { results: shareRows } = await c.env.DB.prepare(
    `SELECT shared_by_user_id AS member, COUNT(id) AS n FROM content_shares
      WHERE organization_id = ?1 GROUP BY shared_by_user_id`,
  )
    .bind(org.id)
    .all<{ member: string; n: number }>();
  const shareCounts = new Map(shareRows.map((r) => [r.member, int(r.n)]));

  // Opens / unique opens per member.
  const { results: openRows } = await c.env.DB.prepare(
    `SELECT member, COUNT(eid) AS opens, COUNT(DISTINCT ip) AS uniq FROM ${ENGAGEMENT} GROUP BY member`,
  )
    .bind(org.id)
    .all<{ member: string; opens: number; uniq: number }>();
  const opensByMember = new Map(openRows.map((r) => [r.member, r]));

  const out = members.map((m) => {
    const o = opensByMember.get(m.user_id);
    return {
      user_id: m.user_id,
      email: isPlaceholderEmail(m.email) ? null : m.email,
      full_name: m.full_name,
      role: m.role,
      leader_user_id: m.leader_user_id || null,
      shares: shareCounts.get(m.user_id) ?? 0,
      opens: int(o?.opens),
      unique_opens: int(o?.uniq),
    };
  });
  return c.json(sortDesc(out, (m) => m.opens));
});

/** Consolidated per-content performance. Super admin: whole org. Leader: their reps. */
router.get("/analytics/content", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const visible = await visibleMembers(db, org, user);

  let contents = await db.select().from(contentItems).where(eq(contentItems.organizationId, org.id)).all();
  if (!contents.length) return c.json({ total_content: 0, total_shares: 0, total_opens: 0, items: [] });

  // shares + distinct sharing members per content (scoped to visible members).
  const { results: shareRows } = await bindVisible(
    c.env.DB.prepare(
      `SELECT content_id AS cid, COUNT(id) AS shares, COUNT(DISTINCT shared_by_user_id) AS members
         FROM content_shares
        WHERE organization_id = ?1${visible ? ` AND ${visibleSql("shared_by_user_id")}` : ""}
        GROUP BY content_id`,
    ),
    org.id,
    visible,
  ).all<{ cid: string; shares: number; members: number }>();
  const shareAgg = new Map(shareRows.map((r) => [r.cid, r]));

  const { results: openRows } = await bindVisible(
    c.env.DB.prepare(
      `SELECT cid, COUNT(eid) AS opens, COUNT(DISTINCT ip) AS uniq, MAX(at) AS last_at
         FROM ${ENGAGEMENT}${visible ? ` WHERE ${visibleSql("member")}` : ""}
        GROUP BY cid`,
    ),
    org.id,
    visible,
  ).all<{ cid: string; opens: number; uniq: number; last_at: string | null }>();
  const opensAgg = new Map(openRows.map((r) => [r.cid, r]));

  // A leader only sees content their reps have actually shared; a super admin
  // sees the whole library.
  if (visible) contents = contents.filter((ct) => shareAgg.has(ct.id));

  let totalShares = 0;
  let totalOpens = 0;
  const items = contents.map((ct) => {
    const s = shareAgg.get(ct.id);
    const o = opensAgg.get(ct.id);
    totalShares += int(s?.shares);
    totalOpens += int(o?.opens);
    return {
      content_id: ct.id,
      title: ct.title,
      kind: ct.kind,
      is_archived: !!ct.isArchived,
      shares: int(s?.shares),
      sharing_members: int(s?.members),
      opens: int(o?.opens),
      unique_opens: int(o?.uniq),
      last_engaged_at: isoUtc(o?.last_at ?? null),
    };
  });
  return c.json({
    total_content: contents.length,
    total_shares: totalShares,
    total_opens: totalOpens,
    items: sortDesc(items, (i) => i.opens),
  });
});

/** Per-member breakdown for one content item. Leaders see only their reps. */
router.get("/analytics/content/:content_id", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const visible = await visibleMembers(db, org, user);
  const cid = pyUuid(c.req.param("content_id"));
  if (!cid) httpError(400, "Invalid content id.");
  const content = await db
    .select()
    .from(contentItems)
    .where(and(eq(contentItems.id, cid), eq(contentItems.organizationId, org.id)))
    .get();
  if (!content) httpError(404, "Content not found.");

  const params: string[] = visible ? [org.id, visible.leaderId, cid] : [org.id, cid];
  const cidParam = visible ? "?3" : "?2";
  const { results: rows } = await c.env.DB.prepare(
    `SELECT member, COUNT(eid) AS opens, COUNT(DISTINCT ip) AS uniq FROM ${ENGAGEMENT}
      WHERE cid = ${cidParam}${visible ? ` AND ${visibleSql("member")}` : ""}
      GROUP BY member`,
  )
    .bind(...params)
    .all<{ member: string; opens: number; uniq: number }>();

  // Resolve member identities for the contributors.
  const users = new Map<string, { email: string | null; full_name: string | null }>();
  for (const ids of chunk(rows.map((r) => r.member))) {
    const { results } = await c.env.DB.prepare(
      `SELECT id, email, full_name FROM users WHERE id IN (${ids.map(() => "?").join(",")})`,
    )
      .bind(...ids)
      .all<{ id: string; email: string | null; full_name: string | null }>();
    for (const u of results) users.set(u.id, u);
  }

  let totalOpens = 0;
  let totalUniq = 0;
  const members = rows.map((r) => {
    const u = users.get(r.member);
    totalOpens += int(r.opens);
    totalUniq += int(r.uniq);
    return {
      user_id: r.member,
      email: u && !isPlaceholderEmail(u.email) ? u.email : null,
      full_name: u ? u.full_name : null,
      opens: int(r.opens),
      unique_opens: int(r.uniq),
      share_url: null,
    };
  });
  return c.json({
    content_id: content.id,
    title: content.title,
    opens: totalOpens,
    unique_opens: totalUniq,
    members: sortDesc(members, (m) => m.opens),
  });
});

/** Assign (or clear) the leader a member reports to (super admin only). */
router.patch("/members/:user_id", async (c) => {
  const user = await requireOrgAdmin(c);
  const data = await parseJson(c, MemberUpdate);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const memberUuid = pyUuid(c.req.param("user_id"));
  if (!memberUuid) httpError(400, "Invalid user id.");

  const membership = await db
    .select()
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, org.id), eq(organizationMemberships.userId, memberUuid)))
    .get();
  if (!membership) httpError(404, "Member not found in this org.");

  let leaderUuid: string | null = null;
  if (data.leader_user_id) {
    // empty string / null clears the assignment
    leaderUuid = pyUuid(data.leader_user_id);
    if (!leaderUuid) httpError(400, "Invalid leader_user_id.");
    if (leaderUuid === memberUuid) httpError(400, "A member cannot lead themselves.");
    const leader = await db
      .select()
      .from(organizationMemberships)
      .where(and(eq(organizationMemberships.organizationId, org.id), eq(organizationMemberships.userId, leaderUuid)))
      .get();
    if (!leader) httpError(400, "Leader is not a member of this org.");
    if (!(membershipIsLeader(leader) || membershipIsAdmin(leader))) {
      httpError(400, "That member is not a leader or admin.");
    }
  }

  await db
    .update(organizationMemberships)
    .set({ leaderUserId: leaderUuid, updatedAt: nowIso() })
    .where(eq(organizationMemberships.id, membership.id));
  return c.json({ user_id: memberUuid, role: membership.role, leader_user_id: leaderUuid });
});

// ============================================================================
// Assignments (leader -> rep soft recommendations)
// ============================================================================

/**
 * Map assignment id -> whether the assignee has since sent that asset.
 *
 * "Sent" = the rep has a ContentShare of the org's shadow Content for the
 * asset. Computed with set-based queries rather than per-row.
 */
async function sentLookup(db: Db, orgId: string, rows: Assignment[]): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!rows.length) return out;
  const assetIds = [...new Set(rows.map((a) => a.champvaultAssetId))];
  const contentByAsset = new Map<string, string>();
  for (const ids of chunk(assetIds)) {
    const found = await db
      .select({ id: contentItems.id, asset: contentItems.champvaultAssetId })
      .from(contentItems)
      .where(and(eq(contentItems.organizationId, orgId), inArray(contentItems.champvaultAssetId, ids)))
      .all();
    for (const r of found) if (r.asset) contentByAsset.set(r.asset, r.id);
  }
  const shares = new Set<string>();
  for (const ids of chunk([...contentByAsset.values()])) {
    const found = await db
      .select({ cid: contentShares.contentId, uid: contentShares.sharedByUserId })
      .from(contentShares)
      .where(inArray(contentShares.contentId, ids))
      .all();
    for (const r of found) shares.add(`${r.cid}|${r.uid}`);
  }
  for (const a of rows) {
    const cid = contentByAsset.get(a.champvaultAssetId);
    out.set(a.id, !!cid && shares.has(`${cid}|${a.assignedToUserId}`));
  }
  return out;
}

function assignmentResponse(a: Assignment, sent: boolean) {
  return {
    id: a.id,
    champvault_asset_id: a.champvaultAssetId,
    asset_title: a.assetTitle,
    assigned_to_user_id: a.assignedToUserId,
    assigned_by_user_id: a.assignedByUserId || null,
    note: a.note,
    created_at: isoUtc(a.createdAt) ?? "",
    sent,
  };
}

/**
 * Recommend a ChampVault asset to a rep (leader -> their reps; admin -> anyone).
 * Idempotent per (org, asset, rep): re-assigning refreshes the note/title.
 */
router.post("/assignments", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const data = await parseJson(c, AssignmentCreate);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const assignee = pyUuid(data.assigned_to_user_id);
  if (!assignee) httpError(400, "Invalid assigned_to_user_id.");

  const membership = await db
    .select()
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, org.id), eq(organizationMemberships.userId, assignee)))
    .get();
  if (!membership) httpError(400, "Assignee is not a member of this org.");
  // A leader may only assign to their own reps; a super admin may assign to anyone.
  if (!isOrgAdmin(user) && membership.leaderUserId !== user.userId) {
    httpError(403, "You can only assign to your own reps.");
  }

  const existing = await db
    .select()
    .from(assignments)
    .where(
      and(
        eq(assignments.organizationId, org.id),
        eq(assignments.champvaultAssetId, data.champvault_asset_id),
        eq(assignments.assignedToUserId, assignee),
      ),
    )
    .get();
  let assignment: Assignment;
  if (existing) {
    const patch: Partial<Assignment> = { note: data.note ?? null };
    if (data.asset_title) patch.assetTitle = data.asset_title;
    await db.update(assignments).set(patch).where(eq(assignments.id, existing.id));
    assignment = { ...existing, ...patch };
  } else {
    assignment = (await db
      .insert(assignments)
      .values({
        id: crypto.randomUUID(),
        organizationId: org.id,
        champvaultAssetId: data.champvault_asset_id,
        assetTitle: data.asset_title ?? null,
        assignedToUserId: assignee,
        assignedByUserId: user.userId,
        note: data.note ?? null,
        createdAt: nowIso(),
      })
      .returning()
      .get()) as Assignment;
  }
  const sent = await sentLookup(db, org.id, [assignment]);
  return c.json(assignmentResponse(assignment, sent.get(assignment.id) ?? false), 201);
});

/** The assets a leader has recommended to the caller, with sent status. */
router.get("/assignments/mine", async (c) => {
  const user = await requireOrgMember(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const rows = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.organizationId, org.id), eq(assignments.assignedToUserId, user.userId)))
    .orderBy(desc(assignments.createdAt))
    .all();
  const sent = await sentLookup(db, org.id, rows);
  return c.json(rows.map((a) => assignmentResponse(a, sent.get(a.id) ?? false)));
});

/** Assignments the caller made (leader) or every one in the org (super admin). */
router.get("/assignments", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const where = isOrgAdmin(user)
    ? eq(assignments.organizationId, org.id)
    : and(eq(assignments.organizationId, org.id), eq(assignments.assignedByUserId, user.userId));
  const rows = await db.select().from(assignments).where(where).orderBy(desc(assignments.createdAt)).all();
  const sent = await sentLookup(db, org.id, rows);
  return c.json(rows.map((a) => assignmentResponse(a, sent.get(a.id) ?? false)));
});

/** Withdraw an assignment (leader: only their own; super admin: any in org). */
router.delete("/assignments/:assignment_id", async (c) => {
  const user = await requireOrgLeaderOrAdmin(c);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const aid = pyUuid(c.req.param("assignment_id"));
  if (!aid) httpError(400, "Invalid assignment id.");
  const assignment = await db
    .select()
    .from(assignments)
    .where(and(eq(assignments.id, aid), eq(assignments.organizationId, org.id)))
    .get();
  if (!assignment) httpError(404, "Assignment not found.");
  if (!isOrgAdmin(user) && assignment.assignedByUserId !== user.userId) {
    httpError(403, "You can only withdraw your own assignments.");
  }
  await db.delete(assignments).where(eq(assignments.id, assignment.id));
  return c.body(null, 204);
});
