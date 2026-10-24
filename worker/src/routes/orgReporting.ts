/**
 * Org administration surface mounted at /api/v1/org (alongside routes/org.ts):
 * profile context, reporting-viewer grants, org domains, scoped reporting.
 *
 * Every filter is enforced server side from the caller's own scope; a query
 * string org/team/user id is only ever narrowed INSIDE that scope. A viewer
 * grant carries read-only reporting and no write or secret right.
 */
import { Hono } from "hono";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { AppEnv } from "../env";
import { permissionsForRole } from "../auth/permissions";
import { requireAuth, requireOrgMember, requirePermission } from "../auth/security";
import { chunk } from "../db/client";
import { DOMAIN_STATUS_ACTIVE, domains, organizations, reportingGrants, users } from "../db/schema";
import { httpError } from "../lib/errors";
import { isoUtc, nowIso } from "../lib/time";
import { parseJson, parseQuery, qStr } from "../lib/validate";
import { availableDomains, defaultDomainFor, platformShareHost } from "../services/domains";
import { getActiveMembershipRow, membershipIsAdmin, membershipIsLeader } from "../services/org";
import { activeGrants, reportScope, teamOf } from "../services/reporting";
import { isPlaceholderEmail, orgForUser, pyUuid } from "./_org";

export const router = new Hono<AppEnv>({ strict: false });

const int = (v: unknown) => Number(v ?? 0) || 0;

// ============================================================================
// Profile context
// ============================================================================

/** Who am I, in which org, what may I do, which host do new shares use. */
router.get("/profile", async (c) => {
  const user = await requireAuth(c);
  const db = c.var.db;
  const me = await db.select().from(users).where(eq(users.id, user.userId)).get();
  const org = user.orgUuid ? await db.select().from(organizations).where(eq(organizations.id, user.orgUuid)).get() : null;
  const scope = await reportScope(db, user);
  const def = await defaultDomainFor(db, user);
  const hosts = await availableDomains(db, user);
  return c.json({
    user_id: user.userId,
    email: me && !isPlaceholderEmail(me.email) ? me.email : null,
    full_name: me?.fullName ?? null,
    org: org ? { id: org.clerkOrgId, name: org.name, slug: org.slug } : null,
    role: org ? user.orgRole ?? null : null,
    permissions: org ? [...permissionsForRole(user.orgRole)].sort() : [],
    report_scope: scope.kind,
    share_host: { default: def?.hostname ?? platformShareHost(c.var.settings), default_domain_id: def?.id ?? null },
    available_hosts: hosts.map((d) => ({ id: d.id, hostname: d.hostname, org_default: !!d.isOrgDefault })),
  });
});

// ============================================================================
// Reporting viewer grants (org.viewers.grant)
// ============================================================================

const GrantCreate = z.object({
  user_id: z.string(),
  scope: z.enum(["org", "team"]),
  leader_user_id: z.string().nullish(),
});

const grantResponse = (g: typeof reportingGrants.$inferSelect) => ({
  id: g.id,
  user_id: g.userId,
  scope: g.scope,
  leader_user_id: g.leaderUserId,
  granted_by_user_id: g.grantedByUserId,
  created_at: isoUtc(g.createdAt) ?? "",
});

router.get("/viewers", async (c) => {
  const user = await requirePermission(c, "org.viewers.grant");
  const org = await orgForUser(c.var.db, user);
  return c.json((await activeGrants(c.var.db, org.id)).map(grantResponse));
});

/** Grant read-only reporting to an existing member. Idempotent for an identical live grant. */
router.post("/viewers", async (c) => {
  const user = await requirePermission(c, "org.viewers.grant");
  const data = await parseJson(c, GrantCreate);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const target = pyUuid(data.user_id);
  if (!target) httpError(400, "Invalid user_id.");
  if (!(await getActiveMembershipRow(db, org.id, target!))) httpError(400, "That user is not an active member of this org.");

  let leader: string | null = null;
  if (data.scope === "team") {
    leader = pyUuid(data.leader_user_id);
    if (!leader) httpError(400, "A team grant needs a valid leader_user_id.");
    const lm = await getActiveMembershipRow(db, org.id, leader!);
    if (!lm) httpError(400, "Leader is not an active member of this org.");
    if (!(membershipIsLeader(lm!) || membershipIsAdmin(lm!))) httpError(400, "That member is not a leader or admin.");
  } else if (data.leader_user_id) {
    httpError(400, "An org-wide grant takes no leader_user_id.");
  }

  const existing = (await activeGrants(db, org.id, target!)).find((g) => g.scope === data.scope && g.leaderUserId === leader);
  if (existing) return c.json(grantResponse(existing));
  const row = await db
    .insert(reportingGrants)
    .values({
      id: crypto.randomUUID(),
      organizationId: org.id,
      userId: target!,
      scope: data.scope,
      leaderUserId: leader,
      grantedByUserId: user.userId,
      createdAt: nowIso(),
    })
    .returning()
    .get();
  return c.json(grantResponse(row), 201);
});

router.delete("/viewers/:grant_id", async (c) => {
  const user = await requirePermission(c, "org.viewers.grant");
  const org = await orgForUser(c.var.db, user);
  const gid = pyUuid(c.req.param("grant_id"));
  if (!gid) httpError(400, "Invalid grant id.");
  const g = await c.var.db
    .select()
    .from(reportingGrants)
    .where(and(eq(reportingGrants.id, gid!), eq(reportingGrants.organizationId, org.id)))
    .get();
  if (!g) httpError(404, "Grant not found.");
  if (!g!.revokedAt) await c.var.db.update(reportingGrants).set({ revokedAt: nowIso() }).where(eq(reportingGrants.id, g!.id));
  return c.body(null, 204);
});

// ============================================================================
// Org domains (org.domains.manage to change, any org member to read)
// ============================================================================

const orgDomainResponse = (d: typeof domains.$inferSelect) => ({
  id: d.id,
  hostname: d.hostname,
  status: d.status,
  is_org_default: !!d.isOrgDefault,
});

router.get("/domains", async (c) => {
  const user = await requireOrgMember(c);
  const org = await orgForUser(c.var.db, user);
  const rows = await c.var.db.select().from(domains).where(eq(domains.organizationId, org.id)).all();
  // Members only ever see hosts that are verified and active; admins see pending ones too.
  const admin = permissionsForRole(user.orgRole).has("org.domains.manage");
  return c.json(rows.filter((d) => admin || d.status === DOMAIN_STATUS_ACTIVE).map(orgDomainResponse));
});

/** Explicit admin act: attach a verified domain the admin owns to the org. Never automatic. */
router.post("/domains/:domain_id/attach", async (c) => {
  const user = await requirePermission(c, "org.domains.manage");
  const org = await orgForUser(c.var.db, user);
  const d = await c.var.db.select().from(domains).where(eq(domains.id, c.req.param("domain_id"))).get();
  if (!d || d.userId !== user.userId) httpError(404, "Domain not found.");
  if (d!.organizationId && d!.organizationId !== org.id) httpError(409, "This domain belongs to another organization.");
  if (d!.status !== DOMAIN_STATUS_ACTIVE) httpError(400, "Only a verified, active domain can be attached.");
  await c.var.db.update(domains).set({ organizationId: org.id }).where(eq(domains.id, d!.id));
  return c.json(orgDomainResponse({ ...d!, organizationId: org.id }));
});

/** Make one active org domain the default for new org shares. */
router.post("/domains/:domain_id/default", async (c) => {
  const user = await requirePermission(c, "org.domains.manage");
  const org = await orgForUser(c.var.db, user);
  const d = await c.var.db
    .select()
    .from(domains)
    .where(and(eq(domains.id, c.req.param("domain_id")), eq(domains.organizationId, org.id)))
    .get();
  if (!d) httpError(404, "Domain not found.");
  if (d!.status !== DOMAIN_STATUS_ACTIVE) httpError(400, "Only a verified, active domain can be the default.");
  // Clear then set in one batch: the partial unique index allows a single default per org.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE domains SET is_org_default = 0 WHERE organization_id = ?1 AND is_org_default = 1").bind(org.id),
    c.env.DB.prepare("UPDATE domains SET is_org_default = 1 WHERE id = ?1").bind(d!.id),
  ]);
  return c.json(orgDomainResponse({ ...d!, isOrgDefault: true }));
});

// ============================================================================
// Scoped reporting
// ============================================================================

const ReportQuery = z.object({
  team: qStr(), // a leader's user id: that leader plus their active reps
  user: qStr(),
  kind: z.enum(["file", "page", "link"]).optional(),
  from: qStr(),
  to: qStr(),
});

function boundary(v: string | undefined, name: string, fallback: string): string {
  if (!v) return fallback;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) httpError(400, `Invalid ${name} timestamp.`);
  return d.toISOString();
}

interface Row {
  uid: string;
  okind: "file" | "page" | "link";
  n: number;
}

/**
 * Shares created, opens (file/page views) and clicks (tracked links) for the
 * caller's reporting scope. `emails_sent` is always not_measured: this system
 * mints links, it does not send mail, and a count needs a provider event id.
 */
router.get("/reporting/summary", async (c) => {
  const user = await requireOrgMember(c);
  const q = parseQuery(c, ReportQuery);
  const db = c.var.db;
  const org = await orgForUser(db, user);
  const scope = await reportScope(db, user);
  if (scope.kind === "none") httpError(403, "You do not have reporting access in this organization.");

  // Narrow inside the scope, never beyond it.
  let allowed: Set<string> | null = scope.userIds;
  const narrow = (ids: Set<string>) => (allowed = allowed ? new Set([...ids].filter((i) => allowed!.has(i))) : ids);
  if (q.team) {
    const leader = pyUuid(q.team);
    if (!leader) httpError(400, "Invalid team id.");
    const team = await teamOf(db, org.id, [leader!]);
    if (allowed && !allowed.has(leader!)) httpError(403, "That team is outside your reporting scope.");
    narrow(team);
  }
  if (q.user) {
    const uid = pyUuid(q.user);
    if (!uid) httpError(400, "Invalid user id.");
    if (allowed && !allowed.has(uid!)) httpError(403, "That member is outside your reporting scope.");
    narrow(new Set([uid!]));
  }

  const from = boundary(q.from, "from", "0000-01-01T00:00:00.000Z");
  const to = boundary(q.to, "to", "9999-12-31T23:59:59.999Z");
  const KIND = "CASE WHEN f.share_intent IS NOT NULL THEN CASE f.share_intent WHEN 'host' THEN 'page' ELSE 'file' END WHEN f.slug IS NOT NULL THEN 'page' ELSE 'file' END";
  const run = async (sql: string) => (await c.env.DB.prepare(sql).bind(org.id, from, to).all<Row>()).results;

  const [filesMade, filesOpened, linksMade, linksClicked] = await Promise.all([
    run(`SELECT f.user_id AS uid, ${KIND} AS okind, COUNT(*) AS n FROM file_assets f
          WHERE f.organization_id = ?1 AND f.status != 'deleted' AND f.created_at >= ?2 AND f.created_at <= ?3 GROUP BY uid, okind`),
    run(`SELECT f.user_id AS uid, ${KIND} AS okind, COUNT(e.id) AS n FROM click_events e JOIN file_assets f ON f.id = e.file_id
          WHERE f.organization_id = ?1 AND e.clicked_at >= ?2 AND e.clicked_at <= ?3 GROUP BY uid, okind`),
    run(`SELECT l.user_id AS uid, 'link' AS okind, COUNT(*) AS n FROM link_clicks l
          WHERE l.organization_id = ?1 AND l.created_at >= ?2 AND l.created_at <= ?3 GROUP BY uid`),
    run(`SELECT l.user_id AS uid, 'link' AS okind, COUNT(e.id) AS n FROM click_events e JOIN link_clicks l ON l.id = e.link_id
          WHERE l.organization_id = ?1 AND e.clicked_at >= ?2 AND e.clicked_at <= ?3 GROUP BY uid`),
  ]);

  const byKind = { file: { shares_created: 0, opens: 0, clicks: 0 }, page: { shares_created: 0, opens: 0, clicks: 0 }, link: { shares_created: 0, opens: 0, clicks: 0 } };
  const byMember = new Map<string, { shares_created: number; opens: number; clicks: number }>();
  const add = (rows: Row[], field: "shares_created" | "opens" | "clicks") => {
    for (const r of rows) {
      if (!r.uid || (allowed && !allowed.has(r.uid))) continue;
      if (q.kind && r.okind !== q.kind) continue;
      byKind[r.okind][field] += int(r.n);
      const m = byMember.get(r.uid) ?? { shares_created: 0, opens: 0, clicks: 0 };
      m[field] += int(r.n);
      byMember.set(r.uid, m);
    }
  };
  add(filesMade, "shares_created");
  add(filesOpened, "opens");
  add(linksMade, "shares_created");
  add(linksClicked, "clicks");

  const names = new Map<string, string | null>();
  for (const ids of chunk([...byMember.keys()])) {
    for (const r of await db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, ids)).all()) names.set(r.id, r.name);
  }
  const sum = (f: "shares_created" | "opens" | "clicks") => Object.values(byKind).reduce((a, k) => a + k[f], 0);
  return c.json({
    scope: scope.kind,
    filters: { team: q.team ?? null, user: q.user ?? null, kind: q.kind ?? null, from: q.from ? from : null, to: q.to ? to : null },
    totals: { shares_created: sum("shares_created"), opens: sum("opens"), clicks: sum("clicks") },
    emails_sent: { status: "not_measured", count: null, note: "Beam mints links; a sent count needs a provider event id." },
    by_kind: byKind,
    by_member: [...byMember].map(([id, v]) => ({ user_id: id, full_name: names.get(id) ?? null, ...v })).sort((a, b) => b.opens + b.clicks - (a.opens + a.clicks)),
  });
});
