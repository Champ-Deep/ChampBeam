/**
 * Platform super admin, mounted at /api/v1/admin. Every route needs a session whose email is in
 * SUPER_ADMIN_EMAILS (and verified or Google-linked); every action writes an admin_audit row in the
 * same D1 batch as the change, so a change and its audit row land together or not at all.
 */
import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv, Ctx } from "../env";
import { authOf, requireSuperAdmin } from "../auth/security";
import { isUniqueViolation } from "../db/client";
import { domains, organizationMemberships, organizations, users } from "../db/schema";
import { httpError } from "../lib/errors";
import { nowIso } from "../lib/time";
import { parseJson } from "../lib/validate";
import { slugProblem } from "../services/orgSlug";
import { getActiveMembershipRow } from "../services/org";

export const router = new Hono<AppEnv>({ strict: false });

const ROLE = z.enum(["admin", "leader", "member", "viewer"]);
const UserRef = z.object({ user_id: z.string().optional(), email: z.string().optional() });

const audit = (c: Ctx, actor: string, action: string, target: string, payload: unknown) =>
  c.env.DB.prepare("INSERT INTO admin_audit (id, actor_user_id, action, target, payload, at) VALUES (?,?,?,?,?,?)").bind(
    crypto.randomUUID(),
    actor,
    action,
    target,
    JSON.stringify(payload),
    nowIso(),
  );

async function findUser(c: Ctx, ref: { user_id?: string; email?: string }) {
  const where = ref.user_id ? eq(users.id, ref.user_id) : ref.email ? sql`lower(${users.email}) = ${ref.email.trim().toLowerCase()}` : null;
  if (!where) httpError(422, "Give user_id or email.");
  const u = await c.var.db.select({ id: users.id, email: users.email }).from(users).where(where!).get();
  if (!u) httpError(404, "User not found.");
  return u!;
}

async function requireOrg(c: Ctx, id: string) {
  const o = await c.var.db.select().from(organizations).where(eq(organizations.id, id)).get();
  if (!o) httpError(404, "Organization not found.");
  return o!;
}

/** Add (or re-activate a tombstoned) membership; an existing active one keeps its role. */
const upsertMember = (c: Ctx, orgId: string, userId: string, role: string) => {
  const now = nowIso();
  return c.env.DB.prepare(
    `INSERT INTO organization_memberships (id, organization_id, user_id, role, status, created_at, updated_at)
     VALUES (?,?,?,?, 'active', ?, ?)
     ON CONFLICT (organization_id, user_id) DO UPDATE SET
       role = CASE WHEN status = 'active' THEN role ELSE excluded.role END,
       status = 'active', revoked_at = NULL, updated_at = excluded.updated_at`,
  ).bind(crypto.randomUUID(), orgId, userId, role, now, now);
};

/** All orgs with member and content counts. */
router.get("/orgs", async (c) => {
  await requireSuperAdmin(c);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 200, 1), 500);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const { results } = await c.env.DB.prepare(
    `SELECT o.id, o.name, o.slug, o.created_at,
       (SELECT COUNT(*) FROM organization_memberships m WHERE m.organization_id = o.id) AS members,
       (SELECT COUNT(*) FROM content_items i WHERE i.organization_id = o.id) AS content_items,
       (SELECT COUNT(*) FROM file_assets f WHERE f.organization_id = o.id) AS files,
       (SELECT COUNT(*) FROM link_clicks l WHERE l.organization_id = o.id) AS links
     FROM organizations o ORDER BY o.created_at, o.id LIMIT ?1 OFFSET ?2`,
  )
    .bind(limit, offset)
    .all();
  return c.json({ orgs: results, limit, offset });
});

const OrgCreate = UserRef.extend({ name: z.string().trim().min(1).max(100), slug: z.string() });

/** Create an org with any existing user as its first admin. */
router.post("/orgs", async (c) => {
  const actor = await requireSuperAdmin(c);
  const body = await parseJson(c, OrgCreate);
  const why = slugProblem(body.slug);
  if (why) httpError(400, why);
  const admin = await findUser(c, body);
  const orgId = crypto.randomUUID();
  const now = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO organizations (id, clerk_org_id, name, slug, created_at, updated_at) VALUES (?,?,?,?,?,?)").bind(orgId, crypto.randomUUID(), body.name, body.slug, now, now),
      upsertMember(c, orgId, admin.id, "admin"),
      audit(c, actor.userId, "org.create", orgId, { name: body.name, slug: body.slug, first_admin: admin.id }),
    ]);
  } catch (err) {
    if (isUniqueViolation(err)) httpError(409, "That slug is already taken.");
    throw err;
  }
  return c.json({ id: orgId, name: body.name, slug: body.slug, first_admin_user_id: admin.id }, 201);
});

const MemberAdd = UserRef.extend({ role: ROLE });

/** Add any existing user to any org with a role. */
router.post("/orgs/:orgId/members", async (c) => {
  const actor = await requireSuperAdmin(c);
  const org = await requireOrg(c, c.req.param("orgId"));
  const body = await parseJson(c, MemberAdd);
  const user = await findUser(c, body);
  if (await getActiveMembershipRow(c.var.db, org.id, user.id)) httpError(409, "Already a member. Change the role through the organization.");
  await c.env.DB.batch([upsertMember(c, org.id, user.id, body.role), audit(c, actor.userId, "member.add", org.id, { user_id: user.id, role: body.role })]);
  return c.json({ organization_id: org.id, user_id: user.id, role: body.role }, 201);
});

const MemberMove = z.object({
  user_id: z.string(),
  from_org_id: z.string(),
  to_org_id: z.string(),
  role: ROLE.optional(),
  move_content: z.boolean().default(true),
  leave_source: z.boolean().default(true),
});

/**
 * Move a member between orgs, optionally with their content. Port of cb-migrate/lakeb2b_move.py: the
 * org-scoped file_assets, link_clicks, content_items and content_shares they own follow them, and so do
 * their open sessions. One db.batch, so it is all or nothing.
 * Known limit (same as the script): a share of someone else's content item moves, the item stays behind.
 */
router.post("/members/move", async (c) => {
  const actor = await requireSuperAdmin(c);
  const b = await parseJson(c, MemberMove);
  if (b.from_org_id === b.to_org_id) httpError(400, "Source and destination are the same org.");
  const [src, dst] = [await requireOrg(c, b.from_org_id), await requireOrg(c, b.to_org_id)];
  const m = await getActiveMembershipRow(c.var.db, src.id, b.user_id);
  if (!m) httpError(404, "User is not an active member of the source org.");
  if (b.leave_source && m!.role === "admin") {
    const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = ? AND role = 'admin' AND status = 'active'").bind(src.id).first<{ n: number }>();
    if ((n?.n ?? 0) <= 1) httpError(409, "Cannot move the last admin out of the source org. Promote another admin first.");
  }
  const role = b.role ?? (["admin", "leader", "member", "viewer"].includes(m!.role) ? m!.role : "member");
  const now = nowIso();
  const D = c.env.DB;
  const stmts = [upsertMember(c, dst.id, b.user_id, role)];
  if (b.move_content) {
    for (const [table, col] of [
      ["file_assets", "user_id"],
      ["link_clicks", "user_id"],
      ["content_items", "created_by_user_id"],
      ["content_shares", "shared_by_user_id"],
    ] as const) {
      stmts.push(D.prepare(`UPDATE ${table} SET organization_id = ?1 WHERE organization_id = ?2 AND ${col} = ?3`).bind(dst.id, src.id, b.user_id));
    }
  }
  if (b.leave_source) {
    stmts.push(
      D.prepare("DELETE FROM organization_memberships WHERE organization_id = ? AND user_id = ?").bind(src.id, b.user_id),
      // What Better Auth's afterRemoveMember does: end their reporting grants, and un-point their reps.
      D.prepare("UPDATE reporting_grants SET revoked_at = ?1 WHERE organization_id = ?2 AND user_id = ?3 AND revoked_at IS NULL").bind(now, src.id, b.user_id),
      D.prepare("UPDATE organization_memberships SET leader_user_id = NULL WHERE organization_id = ? AND leader_user_id = ?").bind(src.id, b.user_id),
      D.prepare("UPDATE session SET active_organization_id = ?1 WHERE active_organization_id = ?2 AND user_id = ?3").bind(dst.id, src.id, b.user_id),
    );
  }
  stmts.push(audit(c, actor.userId, "member.move", b.user_id, { from: src.id, to: dst.id, role, move_content: b.move_content, leave_source: b.leave_source }));
  try {
    await D.batch(stmts);
  } catch (err) {
    if (isUniqueViolation(err)) httpError(409, "Destination already has conflicting content (same ChampVault asset). Nothing was moved.");
    throw err;
  }
  return c.json({ user_id: b.user_id, from_org_id: src.id, to_org_id: dst.id, role, move_content: b.move_content, leave_source: b.leave_source });
});

/** Switch this session into any org; the identity then acts as admin there (see resolveSession). */
router.post("/act-as", async (c) => {
  const actor = await requireSuperAdmin(c);
  const { organization_id } = await parseJson(c, z.object({ organization_id: z.string().nullable() }));
  if (organization_id) await requireOrg(c, organization_id);
  const s = await authOf(c).api.getSession({ headers: c.req.raw.headers });
  if (!s) httpError(401, "Authentication required");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE session SET active_organization_id = ? WHERE id = ?").bind(organization_id, s!.session.id),
    audit(c, actor.userId, "act_as", organization_id ?? "personal", {}),
  ]);
  return c.json({ active_organization_id: organization_id });
});

const Legacy = z.object({ legacy_platform_before: z.string().nullable() });

/** Let a domain also serve old platform-bucket content (share.lakeb2b.com: 2026-11-06T13:21:38Z). */
router.put("/domains/:id/legacy", async (c) => {
  const actor = await requireSuperAdmin(c);
  const { legacy_platform_before } = await parseJson(c, Legacy);
  // Stored like every other timestamp (ISO with ms, Z) so the text comparison in assetLookup is a time comparison.
  const when = legacy_platform_before === null ? null : new Date(legacy_platform_before);
  if (when && Number.isNaN(when.getTime())) httpError(400, "legacy_platform_before must be an ISO-8601 instant.");
  const iso = when ? when.toISOString() : null;
  const id = c.req.param("id");
  if (!(await c.var.db.select({ id: domains.id }).from(domains).where(eq(domains.id, id)).get())) httpError(404, "Domain not found.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE domains SET legacy_platform_before = ? WHERE id = ?").bind(iso, id),
    audit(c, actor.userId, "domain.legacy", id, { legacy_platform_before: iso }),
  ]);
  return c.json({ id, legacy_platform_before: iso });
});
