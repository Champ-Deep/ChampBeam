/**
 * Intranet API: invite-only, review-gated file transfer (BRD v1.0). Port of backend/app/api/v1/intranet.py.
 *
 * Mounted at /api/v1/intranet. Every route needs a Better Auth session whose active org membership is
 * active (not deactivated) except: invite lookup/accept (they create the account) and the download-ticket
 * GET (a 60-second HMAC ticket bound to user, org, transfer and kind; the membership is re-checked).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Ctx, Settings } from "../env";
import { requireOrgMember } from "../auth/security";
import { createAuth } from "../auth/betterAuth";
import { HTTPError, httpError } from "../lib/errors";
import { enforceLimit } from "../lib/ratelimit";
import { parseJson, parseQuery } from "../lib/validate";
import { bytesToBase64Url, hmacSha256Hex, sha256Hex, timingSafeEqual, tokenUrlsafe } from "../lib/crypto";
import { nowIso } from "../lib/time";
import { background } from "../lib/background";
import { StorageError, StorageNotConfigured, headObject, prepareUpload } from "../lib/storage";
import { classify, computeSha256Async, storageKey } from "../routes/_files";
import { allocateFileShortCode } from "../services/content";
import { clientIp } from "../lib/request";
import * as C from "./constants";
import { append, commit, verifyChain, type LogRow } from "./decisionLog";
import { intranetAcceptInvite, inviteOut, normalizeEmail, type InviteRow } from "./invites";
import * as T from "./transfers";
import { TransferError, type TransferRow } from "./transfers";
import { scanTransfer } from "./scan";
import * as B from "./benchmark";

export const router = new Hono<AppEnv>();

const RATE_LIMIT_PER_MINUTE = 60;
const HEARTBEAT_MS = 30_000;
const TICKET_TTL_SECONDS = 60;
const TICKET_TRANSFER_CODE = "transfer_code";

// ---------------------------------------------------------------------------
// Actor
// ---------------------------------------------------------------------------

export interface Actor {
  userId: string;
  email: string;
  fullName: string | null;
  orgId: string;
  orgName: string | null;
  orgSlug: string | null;
  role: string;
  isAdmin: boolean;
  isReviewer: boolean;
}

const ADMIN_ROLES = new Set(["admin", "org_admin", "super_admin"]);

/** The member row behind (user, org): refuses non-members, deactivated members and orgs outside INTRANET_ORG_IDS. */
export async function actorFor(d1: D1Database, settings: Settings, userId: string, orgId: string): Promise<Actor> {
  const row = await d1
    .prepare(
      `SELECT m.role, m.is_reviewer, m.deactivated_at, m.status, u.email, u.full_name, u.is_active, o.name AS org_name, o.slug AS org_slug
       FROM organization_memberships m JOIN users u ON u.id = m.user_id JOIN organizations o ON o.id = m.organization_id
       WHERE m.organization_id = ?1 AND m.user_id = ?2`,
    )
    .bind(orgId, userId)
    .first<{ role: string; is_reviewer: number; deactivated_at: string | null; status: string; email: string; full_name: string | null; is_active: number | null; org_name: string | null; org_slug: string | null }>();
  const allowed = settings.intranetOrgIdSet;
  if (allowed.size && !allowed.has(orgId) && !(row?.org_slug && allowed.has(row.org_slug))) {
    httpError(403, "This organization is not enabled for the intranet.");
  }
  if (!row || row.status !== "active") httpError(403, "You have not been invited to this organization.");
  if (row.deactivated_at || row.is_active === 0) httpError(403, "Your access has been deactivated.");
  const role = (row.role || "member").toLowerCase();
  return {
    userId,
    email: row.email,
    fullName: row.full_name,
    orgId,
    orgName: row.org_name,
    orgSlug: row.org_slug,
    role,
    isAdmin: ADMIN_ROLES.has(role),
    isReviewer: !!row.is_reviewer,
  };
}

async function requireActive(c: Ctx): Promise<Actor> {
  const cached = (c as unknown as { _intranetActor?: Actor })._intranetActor;
  if (cached) return cached;
  const u = await requireOrgMember(c);
  const actor = await actorFor(c.env.DB, c.var.settings, u.userId, u.orgId!);
  (c as unknown as { _intranetActor?: Actor })._intranetActor = actor;
  return actor;
}
async function requireReviewer(c: Ctx): Promise<Actor> {
  const a = await requireActive(c);
  if (!a.isReviewer) httpError(403, "This action requires the Reviewer role.");
  return a;
}
async function requireAdmin(c: Ctx): Promise<Actor> {
  const a = await requireActive(c);
  if (!a.isAdmin) httpError(403, "This action requires an organization admin.");
  return a;
}
async function requireAuditor(c: Ctx): Promise<Actor> {
  const a = await requireActive(c);
  if (!(a.isAdmin || a.isReviewer)) httpError(403, "The decision log is for Reviewers and Admins.");
  return a;
}

const rateLimit = (c: Ctx, userId: string) =>
  enforceLimit(c.env.DB, `intranet_rl:${userId}`, RATE_LIMIT_PER_MINUTE, 60, "Too many requests. Try again in a minute.");

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

type TransferJoined = TransferRow & {
  f_filename: string | null;
  f_size_bytes: number | null;
  f_mime_type: string | null;
  f_sha256: string | null;
  s_email: string | null;
  s_name: string | null;
  r_email: string | null;
  r_name: string | null;
};

const SELECT_T = `SELECT t.*, f.filename AS f_filename, f.size_bytes AS f_size_bytes, f.mime_type AS f_mime_type, f.sha256 AS f_sha256,
  su.email AS s_email, su.full_name AS s_name, ru.email AS r_email, ru.full_name AS r_name
  FROM transfers t LEFT JOIN file_assets f ON f.id = t.file_id
  LEFT JOIN users su ON su.id = t.submitter_user_id LEFT JOIN users ru ON ru.id = t.recipient_user_id`;

function receipt(t: TransferRow): string {
  if (t.state === C.STATE_SCANNING) return "scanning";
  if ((C.PENDING_STATES as readonly string[]).includes(t.state)) return "pending";
  if (t.state === C.STATE_REJECTED) return "rejected";
  if (t.state === C.STATE_REVOKED) return "revoked";
  if (t.first_opened_at) return "opened";
  if (t.state === C.STATE_EXPIRED) return "expired";
  if (t.state === C.STATE_RELEASED) return "not_opened";
  return t.state;
}

const parseJsonCol = (v: string | null) => {
  if (!v) return null;
  try {
    return JSON.parse(v);
  } catch {
    return null;
  }
};

function serialize(t: TransferJoined) {
  return {
    id: t.id,
    state: t.state,
    receipt: receipt(t),
    filename: t.f_filename,
    size_bytes: t.f_size_bytes,
    mime_type: t.f_mime_type,
    sha256: t.f_sha256,
    purpose: t.purpose,
    submitter: { user_id: t.submitter_user_id, email: t.s_email, full_name: t.s_name },
    recipient: { user_id: t.recipient_user_id, email: t.r_email, full_name: t.r_name },
    requested_expires_in_days: t.requested_expires_in_days,
    requested_one_time: !!t.requested_one_time,
    one_time: !!t.one_time,
    expires_at: t.expires_at,
    submitted_at: t.submitted_at,
    agent_window_ends_at: t.agent_window_ends_at,
    hard_expires_at: t.hard_expires_at,
    decided_at: t.decided_at,
    decided_by_type: t.decided_by_type,
    reject_reason: t.reject_reason,
    released_at: t.released_at,
    first_opened_at: t.first_opened_at,
    consumed_at: t.consumed_at,
    expired_at: t.expired_at,
    revoked_at: t.revoked_at,
    age_seconds: Math.max(0, Math.floor((Date.now() - Date.parse(t.submitted_at)) / 1000)),
    scan_status: t.scan_status,
    scan_detail: t.scan_detail,
    reminded_at: t.reminded_at,
    escalated_at: t.escalated_at,
    escalation_reason: t.escalation_reason,
    decided_by_id: t.decided_by_type === C.ACTOR_AGENT ? t.decided_by_id : null,
    agent_result: parseJsonCol(t.agent_result),
    withdrawn_at: t.withdrawn_at,
    access_code_required: !!t.access_code_hash,
  };
}

async function listTransfers(d1: D1Database, where: string, binds: unknown[], order: string, limit = 500) {
  const { results } = await d1.prepare(`${SELECT_T} WHERE ${where} ORDER BY ${order} LIMIT ${limit}`).bind(...binds).all<TransferJoined>();
  return results.map(serialize);
}

async function serializeOne(d1: D1Database, id: string) {
  const row = await d1.prepare(`${SELECT_T} WHERE t.id = ?1`).bind(id).first<TransferJoined>();
  if (!row) httpError(404, "Transfer not found.");
  return serialize(row);
}

async function getOrgTransfer(c: Ctx, actor: Actor, id: string): Promise<TransferRow> {
  const t = /^[0-9a-f-]{36}$/i.test(id) ? await T.getTransfer(c.env.DB, id.toLowerCase()) : null;
  if (!t || t.organization_id !== actor.orgId) httpError(404, "Transfer not found.");
  return t;
}

function canView(actor: Actor, t: TransferRow): boolean {
  if (actor.isReviewer || t.submitter_user_id === actor.userId) return true;
  return t.recipient_user_id === actor.userId && !!t.released_at;
}

function settingsOut(r: T.ReviewSettings) {
  return {
    agent_mode: r.agent_mode,
    agent_window_hours: r.agent_window_hours,
    agent_threshold: r.agent_threshold,
    agent_input_mode: r.agent_input_mode,
    default_expiry_days: r.default_expiry_days,
    hard_expiry_days: r.hard_expiry_days,
    reminder_hours: r.reminder_hours,
  };
}

/** Agent modes this deployment can run (P1 adds the scorers). */
export function availableModes(settings: Settings): string[] {
  const modes = [C.AGENT_OFF];
  if (settings.clefConfigured || settings.reviewAgentAllowMock) modes.push(C.AGENT_LOCAL);
  if (settings.jevConfigured) modes.push(C.AGENT_JEV);
  return modes;
}

function benchmarkProviders(settings: Settings): string[] {
  const out: string[] = [];
  if (settings.clefConfigured) out.push("clef");
  if (settings.jevConfigured) out.push("jev");
  if (settings.reviewAgentAllowMock) out.push("mock");
  return out;
}

// ---------------------------------------------------------------------------
// Me, badges
// ---------------------------------------------------------------------------

router.get("/me", async (c) => {
  const a = await requireActive(c);
  const s = c.var.settings;
  const review = await T.getReviewSettings(c.env.DB, a.orgId);
  return c.json({
    user: { user_id: a.userId, email: a.email, full_name: a.fullName },
    organization: { id: a.orgId, name: a.orgName, slug: a.orgSlug },
    is_admin: a.isAdmin,
    is_reviewer: a.isReviewer,
    settings: settingsOut(review),
    limits: {
      max_file_bytes: T.effectiveMaxFileBytes(s),
      max_bytes_per_user: s.maxBytesPerUser,
      max_expiry_days: s.intranetMaxExpiryDays,
      blocked_extensions: [...s.intranetBlockedExtensionSet].sort(),
    },
    malware_scan: s.clamdConfigured,
    malware_scan_max_bytes: s.clamdConfigured ? s.clamdMaxStreamBytes : null,
    agent: {
      modes: availableModes(s),
      clef_configured: s.clefConfigured,
      jev_configured: s.jevConfigured,
      benchmark_providers: benchmarkProviders(s),
    },
  });
});

router.get("/badges", async (c) => {
  const a = await requireActive(c);
  const d1 = c.env.DB;
  const inbox = await d1
    .prepare(`SELECT COUNT(*) AS n FROM transfers WHERE organization_id = ?1 AND recipient_user_id = ?2 AND state = '${C.STATE_RELEASED}' AND first_opened_at IS NULL`)
    .bind(a.orgId, a.userId)
    .first<{ n: number }>();
  let queue = 0;
  let overdue = 0;
  if (a.isReviewer) {
    const r = await d1
      .prepare(
        `SELECT COUNT(*) AS n, SUM(CASE WHEN reminded_at IS NOT NULL OR escalated_at IS NOT NULL THEN 1 ELSE 0 END) AS o
         FROM transfers WHERE organization_id = ?1 AND state IN ('${C.STATE_SUBMITTED}', '${C.STATE_IN_REVIEW}') AND submitter_user_id != ?2`,
      )
      .bind(a.orgId, a.userId)
      .first<{ n: number; o: number | null }>();
    queue = r?.n ?? 0;
    overdue = r?.o ?? 0;
  }
  return c.json({ inbox_unopened: inbox?.n ?? 0, review_queue: queue, review_overdue: overdue });
});

// ---------------------------------------------------------------------------
// Members (ACC-4, ACC-5)
// ---------------------------------------------------------------------------

interface MemberJoined {
  user_id: string;
  email: string | null;
  full_name: string | null;
  role: string;
  is_reviewer: number;
  deactivated_at: string | null;
  is_active: number | null;
}

const memberOut = (m: MemberJoined) => ({
  user_id: m.user_id,
  email: m.email,
  full_name: m.full_name,
  role: m.role,
  is_admin: ADMIN_ROLES.has((m.role || "").toLowerCase()),
  is_reviewer: !!m.is_reviewer,
  active: !m.deactivated_at && m.is_active !== 0,
});

const MEMBER_SELECT = `SELECT m.user_id, u.email, u.full_name, m.role, m.is_reviewer, m.deactivated_at, u.is_active
  FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?1 AND m.status = 'active'`;

router.get("/members", async (c) => {
  const a = await requireActive(c);
  const { results } = await c.env.DB.prepare(`${MEMBER_SELECT}${a.isAdmin ? "" : " AND m.deactivated_at IS NULL"} ORDER BY u.full_name, u.email`)
    .bind(a.orgId)
    .all<MemberJoined>();
  return c.json(results.map(memberOut));
});

const MemberPatch = z.object({
  is_reviewer: z.boolean().nullish(),
  role: z.enum(["admin", "member"]).nullish(),
  active: z.boolean().nullish(),
});

router.patch("/members/:user_id", async (c) => {
  const a = await requireAdmin(c);
  const data = await parseJson(c, MemberPatch);
  const uid = c.req.param("user_id");
  const d1 = c.env.DB;
  const m = await d1.prepare(`${MEMBER_SELECT} AND m.user_id = ?2`).bind(a.orgId, uid).first<MemberJoined>();
  if (!m) httpError(404, "Member not found.");
  const isSelf = uid === a.userId;
  if (isSelf && (data.active === false || data.role === "member")) httpError(400, "You cannot deactivate or demote yourself.");

  const changes: Record<string, unknown[]> = {};
  const set: Record<string, unknown> = {};
  const currentRole = ADMIN_ROLES.has(m.role.toLowerCase()) ? "admin" : "member";
  if (data.role != null && data.role !== currentRole) {
    changes.role = [m.role, data.role];
    set.role = data.role;
  }
  if (data.is_reviewer != null && data.is_reviewer !== !!m.is_reviewer) {
    changes.is_reviewer = [!!m.is_reviewer, data.is_reviewer];
    set.is_reviewer = data.is_reviewer ? 1 : 0;
  }
  let event = C.EVENT_MEMBER_UPDATED;
  const after: D1PreparedStatement[] = [];
  if (data.active != null && data.active !== !m.deactivated_at) {
    if (data.active) {
      set.deactivated_at = null;
      event = C.EVENT_MEMBER_REACTIVATED;
    } else {
      set.deactivated_at = nowIso();
      event = C.EVENT_MEMBER_DEACTIVATED;
      // Sign them out everywhere as well; the membership check already refuses them on the next request.
      after.push(d1.prepare("DELETE FROM session WHERE user_id = ?1").bind(uid));
    }
    changes.active = [!data.active, data.active];
  }
  if (Object.keys(changes).length) {
    const cols = Object.keys(set);
    const guard = d1
      .prepare(`UPDATE organization_memberships SET ${cols.map((k, i) => `${k} = ?${i + 3}`).join(", ")}, updated_at = ?${cols.length + 3} WHERE organization_id = ?1 AND user_id = ?2`)
      .bind(a.orgId, uid, ...cols.map((k) => set[k]), nowIso());
    await commit(d1, {
      guard,
      logs: [{ organizationId: a.orgId, event, actorType: C.ACTOR_HUMAN, actorId: a.userId, detail: { member_user_id: uid, changes } }],
      after,
    });
  }
  const fresh = await d1.prepare(`${MEMBER_SELECT} AND m.user_id = ?2`).bind(a.orgId, uid).first<MemberJoined>();
  return c.json(memberOut(fresh!));
});

// ---------------------------------------------------------------------------
// Invites (ACC-1 to ACC-3)
// ---------------------------------------------------------------------------

const InviteCreate = z.object({
  email: z.string().min(3).max(320).regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/),
  role: z.enum(["admin", "member"]).default("member"),
  is_reviewer: z.boolean().default(false),
});

function inviteUrl(c: Ctx, token: string): string {
  const base = (c.var.settings.frontendUrl || new URL(c.req.url).origin).replace(/\/+$/, "");
  return `${base}/accept-invite?token=${encodeURIComponent(token)}`;
}

router.get("/invites", async (c) => {
  const a = await requireAdmin(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM org_invites WHERE organization_id = ?1 ORDER BY created_at DESC LIMIT 200")
    .bind(a.orgId)
    .all<InviteRow>();
  return c.json(results.map(inviteOut));
});

router.post("/invites", async (c) => {
  const a = await requireAdmin(c);
  const data = await parseJson(c, InviteCreate);
  const d1 = c.env.DB;
  const email = normalizeEmail(data.email);
  const existing = await d1
    .prepare("SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?1 AND lower(u.email) = ?2")
    .bind(a.orgId, email)
    .first();
  if (existing) httpError(409, "That person is already a member.");
  const user = await d1.prepare("SELECT 1 FROM users WHERE lower(email) = ?1").bind(email).first();
  if (user) httpError(409, "An account with that email already exists.");
  const now = nowIso();
  const token = tokenUrlsafe(32);
  const inv: InviteRow = {
    id: crypto.randomUUID(),
    organization_id: a.orgId,
    email,
    role: data.role,
    is_reviewer: data.is_reviewer ? 1 : 0,
    token_hash: await sha256Hex(token),
    invited_by_user_id: a.userId,
    created_at: now,
    expires_at: new Date(Date.now() + c.var.settings.intranetInviteTtlDays * 86_400_000).toISOString(),
    revoked_at: null,
    accepted_at: null,
  };
  // A new invite replaces any earlier pending one for the same address.
  await d1.prepare("UPDATE org_invites SET revoked_at = ?3 WHERE organization_id = ?1 AND email = ?2 AND revoked_at IS NULL AND accepted_at IS NULL").bind(a.orgId, email, now).run();
  const guard = d1
    .prepare(
      `INSERT INTO org_invites (id, organization_id, email, role, is_reviewer, token_hash, invited_by_user_id, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(inv.id, inv.organization_id, inv.email, inv.role, inv.is_reviewer, inv.token_hash, inv.invited_by_user_id, inv.created_at, inv.expires_at);
  await commit(d1, {
    guard,
    logs: [
      {
        organizationId: a.orgId,
        event: C.EVENT_INVITED,
        actorType: C.ACTOR_HUMAN,
        actorId: a.userId,
        detail: { invite_id: inv.id, role: inv.role, is_reviewer: !!inv.is_reviewer, email_sha256: await sha256Hex(email) },
      },
    ],
  });
  // The token is returned once; only its hash is stored.
  return c.json({ ...inviteOut(inv), token, invite_url: inviteUrl(c, token) }, 201);
});

router.delete("/invites/:invite_id", async (c) => {
  const a = await requireAdmin(c);
  const d1 = c.env.DB;
  const id = c.req.param("invite_id");
  const inv = await d1.prepare("SELECT * FROM org_invites WHERE id = ?1").bind(id).first<InviteRow>();
  if (!inv || inv.organization_id !== a.orgId) httpError(404, "Invite not found.");
  if (!inv.revoked_at && !inv.accepted_at) {
    const guard = d1.prepare("UPDATE org_invites SET revoked_at = ?2 WHERE id = ?1 AND revoked_at IS NULL AND accepted_at IS NULL").bind(id, nowIso());
    await commit(d1, { guard, logs: [{ organizationId: a.orgId, event: C.EVENT_INVITE_REVOKED, actorType: C.ACTOR_HUMAN, actorId: a.userId, detail: { invite_id: id } }] });
  }
  const fresh = await d1.prepare("SELECT * FROM org_invites WHERE id = ?1").bind(id).first<InviteRow>();
  return c.json(inviteOut(fresh!));
});

async function liveInviteByToken(c: Ctx, token: string): Promise<InviteRow> {
  await enforceLimit(c.env.DB, `intranet_invite_rl:${clientIp(c) ?? "-"}`, 20, 600, "Too many attempts. Try again later.");
  const inv = token ? await c.env.DB.prepare("SELECT * FROM org_invites WHERE token_hash = ?1").bind(await sha256Hex(token)).first<InviteRow>() : null;
  if (!inv) httpError(404, "This invite link is not valid.");
  const status = inviteOut(inv).status;
  if (status !== "pending") httpError(410, `This invite is ${status}. Ask an Admin for a new one.`);
  return inv;
}

/** Public: what an invite link is for, so the sign-up page can show the address. */
router.get("/invites/lookup", async (c) => {
  const { token } = parseQuery(c, z.object({ token: z.string().min(10).max(200) }));
  const inv = await liveInviteByToken(c, token);
  const org = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?1").bind(inv.organization_id).first<{ name: string | null }>();
  return c.json({ email: inv.email, organization: org?.name ?? null, expires_at: inv.expires_at });
});

const AcceptBody = z.object({
  token: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(200),
  password: z.string().min(8).max(128),
});

/** Public: redeem an invite. Creates the account through Better Auth and signs the person in. */
router.post("/invites/accept", async (c) => {
  const data = await parseJson(c, AcceptBody);
  const inv = await liveInviteByToken(c, data.token);
  const user = await c.env.DB.prepare("SELECT 1 FROM users WHERE lower(email) = ?1").bind(inv.email).first();
  if (user) httpError(409, "An account with this email already exists. Sign in instead.");
  const auth = createAuth(c.env, c.var.db, { inviteEmail: inv.email });
  const res = await auth.api.signUpEmail({
    body: { email: inv.email, password: data.password, name: data.name },
    headers: c.req.raw.headers,
    asResponse: true,
  });
  if (!res.ok) return res;
  // Better Auth may run its after-create hook once the response is built: join the org and point the new
  // session at it here, so the first request after sign-up already has its membership (both are idempotent).
  const created = await c.env.DB.prepare("SELECT id FROM users WHERE lower(email) = ?1").bind(inv.email).first<{ id: string }>();
  if (created) {
    await intranetAcceptInvite(c.env.DB, created.id, inv.email);
    await c.env.DB.prepare("UPDATE session SET active_organization_id = ?2 WHERE user_id = ?1 AND active_organization_id IS NULL")
      .bind(created.id, inv.organization_id)
      .run();
  }
  return res;
});

// ---------------------------------------------------------------------------
// Review settings
// ---------------------------------------------------------------------------

const SettingsPatch = z.object({
  agent_mode: z.enum(["off", "local", "jev"]).nullish(),
  agent_window_hours: z.number().int().min(1).max(24 * 14).nullish(),
  agent_threshold: z.number().min(0.5).max(1).nullish(),
  agent_input_mode: z.enum(["metadata_only", "content_excerpt"]).nullish(),
  default_expiry_days: z.number().int().min(1).nullish(),
  hard_expiry_days: z.number().int().min(1).max(90).nullish(),
  reminder_hours: z.number().int().min(1).max(24 * 7).nullish(),
});

router.get("/review-settings", async (c) => {
  const a = await requireActive(c);
  return c.json(settingsOut(await T.getReviewSettings(c.env.DB, a.orgId)));
});

router.put("/review-settings", async (c) => {
  const a = await requireAdmin(c);
  const data = await parseJson(c, SettingsPatch);
  const s = c.var.settings;
  if (data.agent_mode && !availableModes(s).includes(data.agent_mode)) {
    if (data.agent_mode === C.AGENT_JEV) httpError(422, "Jev is not configured on this deployment (set JEV_API_KEY).");
    httpError(422, "The local scorer (Clef) is not configured on this deployment.");
  }
  if (data.default_expiry_days != null && data.default_expiry_days > s.intranetMaxExpiryDays) {
    httpError(422, `Default expiry cannot exceed ${s.intranetMaxExpiryDays} days.`);
  }
  const d1 = c.env.DB;
  const row = await T.getReviewSettings(d1, a.orgId);
  const changes: Record<string, unknown[]> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    const old = (row as unknown as Record<string, unknown>)[k];
    if (old !== v) changes[k] = [old, v];
  }
  if (Object.keys(changes).length) {
    const cols = Object.keys(changes);
    const guard = d1
      .prepare(`UPDATE org_review_settings SET ${cols.map((k, i) => `${k} = ?${i + 2}`).join(", ")}, updated_by_id = ?${cols.length + 2}, updated_at = ?${cols.length + 3} WHERE organization_id = ?1`)
      .bind(a.orgId, ...cols.map((k) => changes[k][1]), a.userId, nowIso());
    const toJev = "agent_mode" in changes && data.agent_mode === C.AGENT_JEV && s.jevSignoffRef;
    await commit(d1, {
      guard,
      logs: [{ organizationId: a.orgId, event: C.EVENT_SETTINGS_CHANGED, actorType: C.ACTOR_HUMAN, actorId: a.userId, detail: toJev ? { changes, jev_signoff_ref: s.jevSignoffRef } : { changes } }],
    });
  }
  return c.json(settingsOut(await T.getReviewSettings(d1, a.orgId)));
});

// ---------------------------------------------------------------------------
// Submission (SUB-1 to SUB-5)
// ---------------------------------------------------------------------------

const UploadInit = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(127).default("application/octet-stream"),
  size_bytes: z.number().int().min(1),
});

router.post("/uploads", async (c) => {
  const a = await requireActive(c);
  await rateLimit(c, a.userId);
  const data = await parseJson(c, UploadInit);
  const s = c.var.settings;
  const d1 = c.env.DB;
  const failures = T.hardCheckFailures(s, data.filename, data.size_bytes);
  if (failures.length) {
    // NFR-4: the reason and size, not the file name.
    await append(d1, {
      organizationId: a.orgId,
      event: C.EVENT_CHECK_FAILED,
      actorType: C.ACTOR_HUMAN,
      actorId: a.userId,
      reason: failures.join("; "),
      detail: { size_bytes: data.size_bytes, stage: "upload" },
    });
    httpError(422, { message: "File failed the intake checks.", failures });
  }
  const used = await d1
    .prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM file_assets WHERE user_id = ?1 AND status != 'deleted'")
    .bind(a.userId)
    .first<{ n: number }>();
  if ((used?.n ?? 0) + data.size_bytes > s.maxBytesPerUser) {
    const MB = 1024 * 1024;
    httpError(402, `Storage quota exceeded (${Math.floor((used?.n ?? 0) / MB)} MB used of ${Math.floor(s.maxBytesPerUser / MB)} MB).`);
  }
  const fileId = crypto.randomUUID();
  const key = C.INTRANET_KEY_PREFIX + storageKey(a.userId, fileId, data.filename);
  let upload;
  try {
    upload = await prepareUpload(s, { fileId, key, contentType: data.content_type, sizeBytes: data.size_bytes });
  } catch (err) {
    if (err instanceof StorageNotConfigured) httpError(503, "File storage is not configured.");
    if (err instanceof StorageError) httpError(502, `Storage error: ${err.message}`);
    throw err;
  }
  const shortCode = await allocateFileShortCode(c.var.db, null);
  await d1
    .prepare(
      `INSERT INTO file_assets (id, user_id, organization_id, short_code, filename, kind, mime_type, size_bytes, storage_key, status, serve_mode, view_count, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'pending_upload', 'stream', 0, ?10)`,
    )
    .bind(fileId, a.userId, a.orgId, shortCode, data.filename, classify(data.content_type), data.content_type, data.size_bytes, key, nowIso())
    .run();
  return c.json({ file_id: fileId, upload_url: upload.url, headers: upload.headers, upload_via_backend: upload.via_backend }, 201);
});

const TransferCreate = z.object({
  file_id: z.string().uuid(),
  recipient_user_id: z.string().min(1).max(64),
  purpose: z.string().trim().min(1).max(500),
  requested_expires_in_days: z.number().int().min(1).nullish(),
  requested_one_time: z.boolean().default(false),
});

router.post("/transfers", async (c) => {
  const a = await requireActive(c);
  const data = await parseJson(c, TransferCreate);
  const s = c.var.settings;
  const d1 = c.env.DB;
  if (data.requested_expires_in_days && data.requested_expires_in_days > s.intranetMaxExpiryDays) {
    httpError(422, `Expiry cannot exceed ${s.intranetMaxExpiryDays} days.`);
  }
  const fid = data.file_id.toLowerCase();
  const asset = await d1.prepare("SELECT * FROM file_assets WHERE id = ?1").bind(fid).first<{ id: string; user_id: string | null; status: string; storage_key: string; size_bytes: number }>();
  if (!asset || asset.user_id !== a.userId || asset.status === "deleted" || !asset.storage_key.startsWith(C.INTRANET_KEY_PREFIX)) {
    httpError(404, "Upload not found.");
  }
  if (await d1.prepare("SELECT 1 FROM transfers WHERE file_id = ?1").bind(fid).first()) httpError(409, "This upload was already submitted.");
  if (data.recipient_user_id === a.userId) httpError(400, "Choose a recipient other than yourself.");
  const recipient = await d1
    .prepare(
      `SELECT 1 FROM organization_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.organization_id = ?1 AND m.user_id = ?2 AND m.status = 'active' AND m.deactivated_at IS NULL AND COALESCE(u.is_active, 1) = 1`,
    )
    .bind(a.orgId, data.recipient_user_id)
    .first();
  if (!recipient) httpError(400, "The recipient is not an active member of this organization.");

  if (asset.status === "pending_upload" || asset.status === "failed") {
    let head;
    try {
      head = await headObject(c.env.FILES, asset.storage_key);
    } catch {
      await d1.prepare("UPDATE file_assets SET status = 'failed' WHERE id = ?1").bind(fid).run();
      httpError(400, "Upload not found in storage. Please upload again.");
    }
    if (Number(head.size) !== asset.size_bytes) {
      await d1.prepare("UPDATE file_assets SET status = 'failed' WHERE id = ?1").bind(fid).run();
      httpError(400, "Uploaded size does not match the declared size.");
    }
    await d1.prepare("UPDATE file_assets SET status = 'active' WHERE id = ?1").bind(fid).run();
  }

  const review = await T.getReviewSettings(d1, a.orgId);
  const now = nowIso();
  const scanning = s.clamdConfigured;
  const scanStatus = scanning ? C.SCAN_PENDING : C.SCAN_NOT_SCANNED;
  const id = crypto.randomUUID();
  const guard = d1
    .prepare(
      `INSERT INTO transfers (id, organization_id, file_id, submitter_user_id, recipient_user_id, purpose, state, requested_expires_in_days,
         requested_one_time, one_time, scan_status, scan_detail, check_results, submitted_at, agent_window_ends_at, hard_expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
    )
    .bind(
      id,
      a.orgId,
      fid,
      a.userId,
      data.recipient_user_id,
      data.purpose,
      scanning ? C.STATE_SCANNING : C.STATE_SUBMITTED,
      data.requested_expires_in_days ?? null,
      data.requested_one_time ? 1 : 0,
      scanStatus,
      scanning ? null : "Malware scanning is not configured.",
      JSON.stringify({ size: "ok", type: "ok", malware_scan: scanStatus }),
      now,
      new Date(Date.now() + review.agent_window_hours * 3_600_000).toISOString(),
      new Date(Date.now() + review.hard_expiry_days * 86_400_000).toISOString(),
    );
  const logs = [
    {
      organizationId: a.orgId,
      transferId: id,
      event: C.EVENT_SUBMITTED,
      actorType: C.ACTOR_HUMAN,
      actorId: a.userId,
      detail: { size_bytes: asset.size_bytes, requested_expires_in_days: data.requested_expires_in_days ?? null, requested_one_time: data.requested_one_time },
    },
  ];
  if (!scanning) logs.push({ organizationId: a.orgId, transferId: id, event: C.EVENT_SCANNED, actorType: C.ACTOR_SYSTEM, actorId: "scanner", detail: { status: C.SCAN_NOT_SCANNED } } as never);
  await commit(d1, { guard, logs });
  background(c, () => computeSha256Async(c.env.FILES, c.var.db, fid, asset.storage_key), "intranet sha256");
  if (scanning) background(c, () => scanTransfer(c.env, s, id), "intranet scan");
  return c.json(await serializeOne(d1, id), 201);
});

router.get("/transfers/mine", async (c) => {
  const a = await requireActive(c);
  return c.json(await listTransfers(c.env.DB, "t.organization_id = ?1 AND t.submitter_user_id = ?2", [a.orgId, a.userId], "t.submitted_at DESC"));
});

router.get("/inbox", async (c) => {
  const a = await requireActive(c);
  return c.json(
    await listTransfers(c.env.DB, "t.organization_id = ?1 AND t.recipient_user_id = ?2 AND t.released_at IS NOT NULL", [a.orgId, a.userId], "t.released_at DESC"),
  );
});

router.get("/transfers/:id", async (c) => {
  const a = await requireActive(c);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  if (!canView(a, t)) httpError(403, "You do not have access to this transfer.");
  return c.json(await serializeOne(c.env.DB, t.id));
});

const ReasonBody = z.object({ reason: z.string().max(1000).nullish() });

async function optionalBody<S extends z.ZodType>(c: Ctx, schema: S): Promise<z.infer<S>> {
  const text = await c.req.raw.clone().text();
  if (!text.trim()) return schema.parse({});
  return parseJson(c, schema);
}

router.post("/transfers/:id/revoke", async (c) => {
  const a = await requireActive(c);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  if (!(a.isReviewer || t.submitter_user_id === a.userId)) httpError(403, "Only the submitter or a Reviewer can revoke.");
  const body = await optionalBody(c, ReasonBody);
  const { key } = await T.revoke(c.env.DB, t, a.userId, body.reason ?? null);
  background(c, () => T.deleteBlob(c.env.FILES, key), "intranet blob delete");
  return c.json(await serializeOne(c.env.DB, t.id));
});

router.post("/transfers/:id/withdraw", async (c) => {
  const a = await requireActive(c);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  const body = await optionalBody(c, ReasonBody);
  const { key } = await T.withdraw(c.env.DB, t, a.userId, body.reason ?? null);
  background(c, () => T.deleteBlob(c.env.FILES, key), "intranet blob delete");
  return c.json(await serializeOne(c.env.DB, t.id));
});

// ---------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------

function downloadHeaders(filename: string, mime: string | null): Headers {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "").replace(/["\n\\]/g, "").slice(0, 200) || "download";
  return new Headers({
    "Content-Type": mime || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename.slice(0, 255))}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "sandbox",
  });
}

interface LiveAsset {
  filename: string;
  mime_type: string | null;
  size_bytes: number;
  storage_key: string;
  status: string;
}

async function liveAsset(d1: D1Database, t: TransferRow): Promise<LiveAsset | null> {
  const f = await d1.prepare("SELECT filename, mime_type, size_bytes, storage_key, status FROM file_assets WHERE id = ?1").bind(t.file_id).first<LiveAsset>();
  return f && f.status === "active" ? f : null;
}

/**
 * Stream an R2 object. `onEnd(true)` runs once every byte has been handed to the client stream,
 * `onEnd(false)` when the client went away or the heartbeat lost the claim.
 */
function streamObject(
  c: Ctx,
  obj: R2ObjectBody,
  size: number,
  headers: Headers,
  hooks: { heartbeat?: () => Promise<boolean>; onEnd?: (ok: boolean) => Promise<void> } = {},
): Response {
  let last = Date.now();
  const beat = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, ctrl) {
      ctrl.enqueue(chunk);
      if (hooks.heartbeat && Date.now() - last > HEARTBEAT_MS) {
        last = Date.now();
        if (!(await hooks.heartbeat())) throw new Error("download claim lost");
      }
    },
  });
  const fixed = new FixedLengthStream(size);
  const done = obj.body
    .pipeThrough(beat)
    .pipeTo(fixed.writable)
    .then(
      () => hooks.onEnd?.(true),
      () => hooks.onEnd?.(false),
    )
    .catch((err) => console.error("intranet: finishing download failed", err));
  try {
    c.executionCtx.waitUntil(done);
  } catch {
    /* no execution context in some tests */
  }
  return new Response(fixed.readable, { status: 200, headers });
}

async function serveTransfer(c: Ctx, a: Actor, t: TransferRow, opts: { accessCode?: string | null; codeVerified?: boolean } = {}): Promise<Response> {
  const d1 = c.env.DB;
  if (t.recipient_user_id === a.userId) {
    if (!opts.codeVerified) await checkAccessCodeHook(c, t, a.userId, opts.accessCode ?? null);
    const claim = await T.claimDownload(d1, c.var.settings, t, a.userId);
    const asset = await liveAsset(d1, t);
    const obj = asset ? await c.env.FILES.get(asset.storage_key) : null;
    if (!asset || !obj) {
      await T.releaseClaim(d1, claim);
      httpError(410, "This file is no longer stored.");
    }
    return streamObject(c, obj, asset.size_bytes, downloadHeaders(asset.filename, asset.mime_type), {
      heartbeat: () => T.heartbeatClaim(d1, claim),
      onEnd: async (ok) => {
        if (ok) await T.deleteBlob(c.env.FILES, await T.completeDownload(d1, claim, a.userId));
        else await T.releaseClaim(d1, claim);
      },
    });
  }
  if (t.submitter_user_id === a.userId) {
    const asset = await liveAsset(d1, t);
    const obj = asset ? await c.env.FILES.get(asset.storage_key) : null;
    if (!asset || !obj) httpError(410, "This file is no longer stored.");
    await append(d1, { organizationId: t.organization_id, transferId: t.id, event: C.EVENT_OPENED_BY_SUBMITTER, actorType: C.ACTOR_HUMAN, actorId: a.userId });
    return streamObject(c, obj, asset.size_bytes, downloadHeaders(asset.filename, asset.mime_type));
  }
  httpError(403, "You do not have access to this file.");
}

async function serveReview(c: Ctx, a: Actor, t: TransferRow): Promise<Response> {
  if (!a.isReviewer) httpError(403, "This action requires the Reviewer role.");
  const d1 = c.env.DB;
  const asset = await liveAsset(d1, t);
  const obj = asset ? await c.env.FILES.get(asset.storage_key) : null;
  if (!asset || !obj) httpError(410, "This file is no longer stored.");
  await T.openForReview(d1, t, a.userId);
  return streamObject(c, obj, asset.size_bytes, downloadHeaders(asset.filename, asset.mime_type));
}

/** Replaced in P2 (access code on release). */
let checkAccessCodeHook: (c: Ctx, t: TransferRow, userId: string, code: string | null) => Promise<void> = async () => {};
export function setAccessCodeHook(fn: typeof checkAccessCodeHook) {
  checkAccessCodeHook = fn;
}

router.get("/transfers/:id/download", async (c) => {
  const a = await requireActive(c);
  await rateLimit(c, a.userId);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  return serveTransfer(c, a, t, { accessCode: c.req.header("x-access-code") ?? null });
});

router.get("/review/:id/file", async (c) => {
  const a = await requireReviewer(c);
  await rateLimit(c, a.userId);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  return serveReview(c, a, t);
});

async function signTicket(settings: Settings, payload: string): Promise<string> {
  return hmacSha256Hex(settings.resolvedUploadSecret, `intranet-ticket:${payload}`);
}

export async function makeDownloadTicket(settings: Settings, transferId: string, userId: string, orgId: string, kind: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TICKET_TTL_SECONDS;
  const payload = `${kind}.${transferId}.${userId}.${orgId}.${exp}`;
  return bytesToBase64Url(new TextEncoder().encode(`${payload}.${await signTicket(settings, payload)}`));
}

async function readDownloadTicket(settings: Settings, ticket: string): Promise<{ kind: string; tid: string; uid: string; org: string } | null> {
  try {
    const b64 = ticket.replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const idx = raw.lastIndexOf(".");
    const payload = raw.slice(0, idx);
    const sig = raw.slice(idx + 1);
    const parts = payload.split(".");
    if (parts.length !== 5) return null;
    const [kind, tid, uid, org, exp] = parts;
    if (!timingSafeEqual(sig, await signTicket(settings, payload))) return null;
    if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
    return { kind, tid, uid, org };
  } catch {
    return null;
  }
}

const TicketBody = z.object({
  kind: z.enum(["transfer", "review"]).default("transfer"),
  access_code: z.string().max(8).nullish(),
});

router.post("/transfers/:id/download-ticket", async (c) => {
  const a = await requireActive(c);
  const body = await optionalBody(c, TicketBody);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  let kind: string = body.kind;
  if (kind === "review" && !a.isReviewer) httpError(403, "This action requires the Reviewer role.");
  if (kind === "transfer" && t.access_code_hash && t.recipient_user_id === a.userId) {
    await checkAccessCodeHook(c, t, a.userId, body.access_code ?? null);
    kind = TICKET_TRANSFER_CODE;
  }
  const ticket = await makeDownloadTicket(c.var.settings, t.id, a.userId, a.orgId, kind);
  return c.json({ url: `/api/v1/intranet/download/${ticket}`, expires_in: TICKET_TTL_SECONDS });
});

router.get("/download/:ticket", async (c) => {
  const parsed = await readDownloadTicket(c.var.settings, c.req.param("ticket"));
  if (!parsed) httpError(404, "Not found.");
  await rateLimit(c, parsed.uid);
  const a = await actorFor(c.env.DB, c.var.settings, parsed.uid, parsed.org);
  const t = await T.getTransfer(c.env.DB, parsed.tid);
  if (!t || t.organization_id !== a.orgId) httpError(404, "Not found.");
  if (parsed.kind === "review") return serveReview(c, a, t);
  return serveTransfer(c, a, t, { codeVerified: parsed.kind === TICKET_TRANSFER_CODE });
});

// ---------------------------------------------------------------------------
// Review (REV-1 to REV-5)
// ---------------------------------------------------------------------------

router.get("/review/queue", async (c) => {
  const a = await requireReviewer(c);
  return c.json(
    await listTransfers(c.env.DB, `t.organization_id = ?1 AND t.state IN ('${C.STATE_SUBMITTED}', '${C.STATE_IN_REVIEW}')`, [a.orgId], "t.submitted_at ASC"),
  );
});

const ApproveBody = z.object({
  expires_in_days: z.number().int().min(1).nullish(),
  one_time: z.boolean().nullish(),
  reason: z.string().max(1000).nullish(),
  access_code: z.string().max(8).nullish(),
});

router.post("/review/:id/approve", async (c) => {
  const a = await requireReviewer(c);
  const body = await optionalBody(c, ApproveBody);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  const review = await T.getReviewSettings(c.env.DB, a.orgId);
  await T.approve(c.env.DB, c.var.settings, t, a.userId, review, {
    expiresInDays: body.expires_in_days ?? null,
    oneTime: body.one_time ?? null,
    reason: body.reason ?? null,
    accessCode: body.access_code ?? null,
  });
  return c.json(await serializeOne(c.env.DB, t.id));
});

const RejectBody = z.object({ reason: z.string().trim().min(1, "A reason is required to reject.").max(1000) });

router.post("/review/:id/reject", async (c) => {
  const a = await requireReviewer(c);
  const body = await parseJson(c, RejectBody);
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  const { key } = await T.reject(c.env.DB, t, a.userId, body.reason);
  background(c, () => T.deleteBlob(c.env.FILES, key), "intranet blob delete");
  return c.json(await serializeOne(c.env.DB, t.id));
});

// Agent approvals a Reviewer can still overturn (AGT-8).
router.get("/review/agent-approved", async (c) => {
  const a = await requireReviewer(c);
  return c.json(
    await listTransfers(
      c.env.DB,
      `t.organization_id = ?1 AND t.state = '${C.STATE_RELEASED}' AND t.decided_by_type = '${C.ACTOR_AGENT}' AND t.first_opened_at IS NULL`,
      [a.orgId],
      "t.released_at DESC",
      200,
    ),
  );
});

router.post("/review/:id/overturn", async (c) => {
  const a = await requireReviewer(c);
  const body = await parseJson(c, z.object({ reason: z.string().max(1000) }));
  const t = await getOrgTransfer(c, a, c.req.param("id"));
  const { key } = await T.overturn(c.env.DB, t, a.userId, body.reason);
  background(c, () => T.deleteBlob(c.env.FILES, key), "intranet blob delete");
  return c.json(await serializeOne(c.env.DB, t.id));
});

// ---------------------------------------------------------------------------
// Agent benchmark (admins)
// ---------------------------------------------------------------------------

router.post("/agent/benchmarks", async (c) => {
  const a = await requireAdmin(c);
  const body = await optionalBody(c, z.object({ provider: z.enum(["clef", "jev", "mock"]).default("clef") }));
  const s = c.var.settings;
  if (!benchmarkProviders(s).includes(body.provider)) httpError(422, `Provider '${body.provider}' is not configured on this deployment.`);
  const d1 = c.env.DB;
  const running = await d1
    .prepare("SELECT 1 FROM agent_benchmarks WHERE organization_id = ?1 AND status IN ('queued', 'running') AND created_at > ?2")
    .bind(a.orgId, new Date(Date.now() - 2 * 3_600_000).toISOString())
    .first();
  if (running) httpError(409, "A benchmark is already running.");
  const row: B.BenchmarkRow = { id: crypto.randomUUID(), organization_id: a.orgId, provider: body.provider, status: "queued", created_at: nowIso(), finished_at: null, created_by_id: a.userId, report: null, error: null };
  await d1
    .prepare("INSERT INTO agent_benchmarks (id, organization_id, provider, status, created_at, created_by_id) VALUES (?1, ?2, ?3, 'queued', ?4, ?5)")
    .bind(row.id, row.organization_id, row.provider, row.created_at, row.created_by_id)
    .run();
  background(c, () => B.runJob(c.env, s, row.id), "agent benchmark");
  return c.json(B.benchmarkOut(row), 202);
});

router.get("/agent/benchmarks", async (c) => {
  const a = await requireAdmin(c);
  const { results } = await c.env.DB.prepare("SELECT * FROM agent_benchmarks WHERE organization_id = ?1 ORDER BY created_at DESC LIMIT 10")
    .bind(a.orgId)
    .all<B.BenchmarkRow>();
  return c.json(results.map(B.benchmarkOut));
});

// ---------------------------------------------------------------------------
// Decision log (7.1): read, CSV export, chain verification. No route writes or deletes rows.
// ---------------------------------------------------------------------------

const LogQuery = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
  actor_id: z.string().optional(),
  event: z.string().optional(),
  transfer_id: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

function logWhere(orgId: string, q: z.infer<typeof LogQuery>): { where: string; binds: unknown[] } {
  const parts = ["organization_id = ?1"];
  const binds: unknown[] = [orgId];
  const add = (sql: string, v: unknown) => {
    binds.push(v);
    parts.push(sql.replace("?", `?${binds.length}`));
  };
  const toIso = (v: string, name: string) => {
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) httpError(422, `Invalid ${name}.`);
    return d.toISOString();
  };
  if (q.start) add("at >= ?", toIso(q.start, "start"));
  if (q.end) add("at <= ?", toIso(q.end, "end"));
  if (q.actor_id) add("actor_id = ?", q.actor_id);
  if (q.transfer_id) add("transfer_id = ?", q.transfer_id.toLowerCase());
  if (q.event) {
    const events = q.event.split(",").map((e) => e.trim()).filter(Boolean);
    if (events.length) {
      const ph = events.map((e) => {
        binds.push(e);
        return `?${binds.length}`;
      });
      parts.push(`event IN (${ph.join(", ")})`);
    }
  }
  return { where: parts.join(" AND "), binds };
}

async function logOut(d1: D1Database, rows: LogRow[]) {
  const ids = [...new Set(rows.filter((r) => r.actor_type === C.ACTOR_HUMAN && r.actor_id).map((r) => r.actor_id!))];
  const people = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const { results } = await d1
      .prepare(`SELECT id, full_name, email FROM users WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(",")})`)
      .bind(...chunk)
      .all<{ id: string; full_name: string | null; email: string | null }>();
    for (const u of results) people.set(u.id, u.full_name || u.email);
  }
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    transfer_id: r.transfer_id,
    event: r.event,
    actor_type: r.actor_type,
    actor_id: r.actor_id,
    actor_name: r.actor_type === C.ACTOR_HUMAN ? (r.actor_id ? people.get(r.actor_id) ?? null : null) : `${r.actor_type}:${r.agent_provider ?? r.actor_id}`,
    reason: r.reason,
    detail: parseJsonCol(r.detail),
    agent_provider: r.agent_provider,
    agent_model: r.agent_model,
    agent_input_mode: r.agent_input_mode,
    agent_p_approve: r.agent_p_approve,
    agent_threshold: r.agent_threshold,
    agent_input_sha256: r.agent_input_sha256,
    prev_hash: r.prev_hash,
    row_hash: r.row_hash,
  }));
}

router.get("/log", async (c) => {
  const a = await requireAuditor(c);
  const q = parseQuery(c, LogQuery);
  const { where, binds } = logWhere(a.orgId, q);
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM decision_log WHERE ${where}`).bind(...binds).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(`SELECT * FROM decision_log WHERE ${where} ORDER BY id DESC LIMIT ${q.limit} OFFSET ${q.offset}`)
    .bind(...binds)
    .all<LogRow>();
  return c.json({ items: await logOut(c.env.DB, results), total: total?.n ?? 0 });
});

const CSV_FORMULA = new Set(["=", "+", "-", "@", "\t", "\r"]);
function csvCell(v: unknown): string {
  if (v == null) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (s && CSV_FORMULA.has(s[0])) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

router.get("/log.csv", async (c) => {
  const a = await requireAuditor(c);
  const q = parseQuery(c, LogQuery);
  const { where, binds } = logWhere(a.orgId, q);
  const cols = [
    "id", "at", "transfer_id", "event", "actor_type", "actor_id", "actor_name", "reason",
    "agent_provider", "agent_model", "agent_input_mode", "agent_p_approve", "agent_threshold",
    "agent_input_sha256", "prev_hash", "row_hash",
  ] as const;
  const lines = [cols.join(",")];
  let lastId = 0;
  for (;;) {
    const { results } = await c.env.DB.prepare(`SELECT * FROM decision_log WHERE ${where} AND id > ?${binds.length + 1} ORDER BY id ASC LIMIT 1000`)
      .bind(...binds, lastId)
      .all<LogRow>();
    if (!results.length) break;
    for (const e of await logOut(c.env.DB, results)) lines.push(cols.map((k) => csvCell((e as Record<string, unknown>)[k])).join(","));
    lastId = results[results.length - 1].id;
  }
  const stamp = nowIso().slice(0, 10).replace(/-/g, "");
  return new Response(lines.join("\r\n") + "\r\n", {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="decision-log-${stamp}.csv"`, "Cache-Control": "no-store" },
  });
});

router.get("/log/verify", async (c) => {
  const a = await requireAuditor(c);
  return c.json(await verifyChain(c.env.DB, a.orgId));
});

export { HTTPError, TransferError };
