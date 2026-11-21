/**
 * Invite-only access on Better Auth (ACC-1 to ACC-3).
 *
 * An Admin creates an invite: a random token whose SHA-256 is stored with the email, role and expiry
 * (INTRANET_INVITE_TTL_DAYS, 7 by default). The Admin passes the invite link on (nothing is emailed). The
 * invitee opens it, picks a password, and POST /api/v1/intranet/invites/accept creates the account through
 * Better Auth with that invite attached. Better Auth's own sign-up route is disabled in intranet mode, and
 * the user-create hook refuses any email without a live invite, so neither an email sign-up nor a social
 * sign-in can create an account for someone who was not invited.
 */
import { nowIso } from "../lib/time";
import * as C from "./constants";
import { commit } from "./decisionLog";

/** Better Auth routes that would create accounts or change org membership outside the logged intranet API. */
export const INTRANET_DISABLED_AUTH_PATHS = [
  "/sign-up/email",
  "/delete-user",
  "/change-email",
  "/organization/create",
  "/organization/update",
  "/organization/delete",
  "/organization/leave",
  "/organization/invite-member",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/cancel-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/add-member",
];

export interface InviteRow {
  id: string;
  organization_id: string;
  email: string;
  role: string;
  is_reviewer: number;
  token_hash: string;
  invited_by_user_id: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  accepted_at: string | null;
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function liveInviteForEmail(d1: D1Database, email: string): Promise<InviteRow | null> {
  return d1
    .prepare(
      `SELECT * FROM org_invites WHERE email = ?1 AND revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?2
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(normalizeEmail(email), nowIso())
    .first<InviteRow>();
}

/** Better Auth user.create.before: null = allowed, else the refusal message. */
export async function intranetCheckSignup(
  d1: D1Database,
  email: string,
  path: string | null,
  inviteEmail: string | null,
): Promise<string | null> {
  const e = normalizeEmail(email);
  if (!e) return "Sign-up is by invitation only.";
  const invite = await liveInviteForEmail(d1, e);
  if (!invite) return "Sign-up is by invitation only. Ask an Admin to invite you.";
  // Social sign-in proves the address; an email sign-up must come through the invite link.
  if (path && path.startsWith("/callback")) return null;
  if (inviteEmail && normalizeEmail(inviteEmail) === e) return null;
  return "Use the link in your invite to create your account.";
}

/** Better Auth user.create.after: join the inviting org with the invited role, mark the invite accepted, log it. */
export async function intranetAcceptInvite(d1: D1Database, userId: string, email: string): Promise<void> {
  const invite = await liveInviteForEmail(d1, email);
  if (!invite) return;
  const now = nowIso();
  const guard = d1.prepare("UPDATE org_invites SET accepted_at = ?2 WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL").bind(invite.id, now);
  const membership = d1
    .prepare(
      `INSERT INTO organization_memberships (id, organization_id, user_id, role, is_reviewer, status, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 'active', ?6, ?6 WHERE changes() > 0
       ON CONFLICT DO NOTHING`,
    )
    .bind(crypto.randomUUID(), invite.organization_id, userId, invite.role, invite.is_reviewer, now);
  await commit(d1, {
    guard,
    logs: [
      {
        organizationId: invite.organization_id,
        event: C.EVENT_INVITE_ACCEPTED,
        actorType: C.ACTOR_HUMAN,
        actorId: userId,
        detail: { invite_id: invite.id, role: invite.role, is_reviewer: !!invite.is_reviewer },
      },
    ],
    after: [membership],
  });
}

export function inviteStatus(inv: InviteRow, now = nowIso()): string {
  if (inv.accepted_at) return "accepted";
  if (inv.revoked_at) return inv.revoked_at >= inv.expires_at ? "expired" : "revoked";
  if (inv.expires_at <= now) return "expired";
  return "pending";
}

export function inviteOut(inv: InviteRow) {
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    is_reviewer: !!inv.is_reviewer,
    status: inviteStatus(inv),
    created_at: inv.created_at,
    expires_at: inv.expires_at,
  };
}
