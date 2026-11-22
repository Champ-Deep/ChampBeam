/**
 * Invitations on top of Better Auth's organization plugin, mounted at /api/v1/org. Better Auth owns the
 * rules (admin only, 7 day expiry, accept needs the invited email); this adds the accept URL to the reply
 * so an admin can copy it whether or not email is configured. The URL is always on the platform host.
 */
import { Hono } from "hono";
import { and, desc, eq, gt } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { z } from "zod";
import type { AppEnv } from "../env";
import { inviteUrl } from "../auth/betterAuth";
import { authOf, requireOrgAdmin, requireSessionAuth } from "../auth/security";
import { invitation } from "../db/schema";
import { httpError } from "../lib/errors";
import { parseJson } from "../lib/validate";

export const router = new Hono<AppEnv>({ strict: false });

const Invite = z.object({
  email: z.string().email().max(254),
  role: z.enum(["admin", "leader", "member", "viewer"]),
  resend: z.boolean().optional(),
});

router.post("/invitations", async (c) => {
  const body = await parseJson(c, Invite);
  const u = await requireSessionAuth(c);
  if (!u.orgId) httpError(403, "Select an organization first.");
  try {
    const inv = await authOf(c).api.createInvitation({
      headers: c.req.raw.headers,
      body: { email: body.email.toLowerCase(), role: body.role, organizationId: u.orgId!, resend: body.resend },
    });
    return c.json({ ...inv, accept_url: inviteUrl(c.var.settings, inv.id), email_sent: c.var.settings.emailEnabled }, 201);
  } catch (err) {
    if (err instanceof APIError) httpError(err.statusCode, err.body?.message ?? err.message);
    throw err;
  }
});

router.get("/invitations", async (c) => {
  const u = await requireOrgAdmin(c);
  const rows = await c.var.db
    .select()
    .from(invitation)
    .where(and(eq(invitation.organizationId, u.orgId!), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())))
    .orderBy(desc(invitation.createdAt))
    .all();
  return c.json(rows.map((r) => ({ id: r.id, email: r.email, role: r.role, expires_at: r.expiresAt.toISOString(), accept_url: inviteUrl(c.var.settings, r.id) })));
});
