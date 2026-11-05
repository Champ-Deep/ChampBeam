/**
 * Port of backend/app/api/v1/webhooks.py — mounted at /api/v1/webhooks.
 *
 * Clerk webhook receiver: keeps the local user + org mirror authoritative.
 * Clerk POSTs svix-signed events here. We handle the user and organization
 * lifecycle so the local users / organizations / organization_memberships
 * tables track Clerk without depending on the lazy on-auth sync. Configure
 * CLERK_WEBHOOK_SECRET and point a Clerk webhook at /api/v1/webhooks/clerk
 * with the user.* and organization* event filters.
 */
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../env";
import type { Db } from "../db/client";
import { MEMBERSHIP_REVOKED, organizationMemberships, organizations, users } from "../db/schema";
import { httpError } from "../lib/errors";
import * as clerk from "../services/clerk";
import * as orgService from "../services/org";
import * as userService from "../services/user";

export const router = new Hono<AppEnv>({ strict: false });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;

router.post("/clerk", async (c) => {
  const settings = c.var.settings;
  if (!settings.clerkWebhookConfigured) {
    httpError(503, "Clerk webhooks are not configured (set CLERK_WEBHOOK_SECRET).");
  }

  // Verify against the exact raw bytes before parsing anything.
  const body = await c.req.text();
  if (!(await clerk.verifyWebhook(settings, c.req.raw.headers, body))) {
    httpError(401, "Invalid webhook signature.");
  }

  const event = JSON.parse(body) as Data;
  const eventType: string = event?.type ?? "";
  const data: Data = event?.data || {};
  console.info(`clerk webhook: ${eventType}`);

  try {
    await dispatch(c.var.db, eventType, data);
  } catch (err) {
    console.error(`clerk webhook handler failed for ${eventType}`, err);
    // 200 so Clerk doesn't hammer retries on a non-transient bug; the lazy
    // on-auth sync remains a backstop.
    return c.json({ ok: false, handled: eventType });
  }
  return c.json({ ok: true, handled: eventType });
});

async function dispatch(db: Db, eventType: string, data: Data): Promise<void> {
  if (eventType === "user.created" || eventType === "user.updated") {
    await handleUserUpsert(db, data);
  } else if (eventType === "user.deleted") {
    await handleUserDeleted(db, data);
  } else if (eventType === "organization.created" || eventType === "organization.updated") {
    if (!data.id) throw new Error("organization event without data.id");
    await orgService.upsertOrganization(db, data.id, { name: data.name, slug: data.slug });
  } else if (eventType === "organization.deleted") {
    await deleteOrganization(db, data.id);
  } else if (
    eventType === "organizationMembership.created" ||
    eventType === "organizationMembership.updated"
  ) {
    await handleMembershipUpsert(db, data);
  } else if (eventType === "organizationMembership.deleted") {
    await handleMembershipDeleted(db, data);
  }
}

async function handleUserUpsert(db: Db, data: Data): Promise<void> {
  const clerkId = data.id;
  if (!clerkId) return;
  const user = await userService.getOrCreateByClerkId(db, clerkId);
  await userService.applyIdentity(db, user, {
    email: clerk.primaryEmail(data),
    fullName: clerk.fullName(data),
  });
}

async function handleUserDeleted(db: Db, data: Data): Promise<void> {
  const clerkId = data.id;
  if (!clerkId) return;
  // Soft-deactivate; keep the row so historical analytics/attribution hold.
  await db.update(users).set({ isActive: false }).where(eq(users.clerkId, clerkId));
}

async function deleteOrganization(db: Db, clerkOrgId: string | null | undefined): Promise<void> {
  if (!clerkOrgId) return;
  // Memberships and other org-scoped rows go with it (ON DELETE CASCADE).
  await db.delete(organizations).where(eq(organizations.clerkOrgId, clerkOrgId));
}

/** Clerk's updated_at (ms) for the event, when present. */
const eventTime = (data: Data): number | null => (typeof data.updated_at === "number" ? data.updated_at : null);

/** True when a newer Clerk event was already applied to this membership (late, retried or out of order). */
const isStale = (at: number | null, stored: number | null | undefined) => at != null && stored != null && at <= stored;

async function stampEventTime(db: Db, organizationId: string, userId: string, at: number | null): Promise<void> {
  if (at == null) return;
  await db
    .update(organizationMemberships)
    .set({ clerkUpdatedAt: at })
    .where(and(eq(organizationMemberships.organizationId, organizationId), eq(organizationMemberships.userId, userId)));
}

async function handleMembershipUpsert(db: Db, data: Data): Promise<void> {
  const orgData: Data = data.organization || {};
  const userData: Data = data.public_user_data || {};
  const clerkOrgId = orgData.id;
  const clerkUserId = userData.user_id;
  if (!(clerkOrgId && clerkUserId)) return;
  const org = await orgService.upsertOrganization(db, clerkOrgId, { name: orgData.name, slug: orgData.slug });
  const user = await userService.getOrCreateByClerkId(db, clerkUserId);
  // Backfill identity from the embedded public_user_data when present.
  const email = userData.identifier ?? null;
  const name = [userData.first_name, userData.last_name].filter((p) => p).join(" ").trim() || null;
  await userService.applyIdentity(db, user, { email, fullName: name });
  // A created/updated event for the very membership Clerk already deleted is a retry or out-of-order
  // delivery: ignore it. A real re-add arrives as a NEW Clerk membership id and does lift the tombstone.
  const existing = await db
    .select({
      status: organizationMemberships.status,
      clerkMembershipId: organizationMemberships.clerkMembershipId,
      clerkUpdatedAt: organizationMemberships.clerkUpdatedAt,
    })
    .from(organizationMemberships)
    .where(and(eq(organizationMemberships.organizationId, org.id), eq(organizationMemberships.userId, user.id)))
    .get();
  if (existing?.status === MEMBERSHIP_REVOKED && data.id && existing.clerkMembershipId === data.id) return;
  const at = eventTime(data);
  if (isStale(at, existing?.clerkUpdatedAt)) return;
  await orgService.upsertMembership(db, org.id, user.id, orgService.normalizeRole(data.role), data.id ?? null);
  await stampEventTime(db, org.id, user.id, at);
}

async function handleMembershipDeleted(db: Db, data: Data): Promise<void> {
  const orgData: Data = data.organization || {};
  const userData: Data = data.public_user_data || {};
  const clerkOrgId = orgData.id;
  const clerkUserId = userData.user_id;
  if (!(clerkOrgId && clerkUserId)) return;
  const row = await db
    .select({ orgId: organizations.id, userId: users.id, clerkUpdatedAt: organizationMemberships.clerkUpdatedAt })
    .from(organizationMemberships)
    .innerJoin(organizations, eq(organizationMemberships.organizationId, organizations.id))
    .innerJoin(users, eq(organizationMemberships.userId, users.id))
    .where(and(eq(organizations.clerkOrgId, clerkOrgId), eq(users.clerkId, clerkUserId)))
    .get();
  // Tombstone, not delete: a still-valid session token must not re-create it. If the delete arrives
  // before any create was mirrored, write the tombstone anyway so the late create cannot revive it.
  const at = eventTime(data);
  if (row) {
    if (isStale(at, row.clerkUpdatedAt)) return; // a later re-add already won
    await orgService.revokeMembership(db, row.orgId, row.userId, data.id ?? null);
    await stampEventTime(db, row.orgId, row.userId, at);
    return;
  }
  const org = await orgService.upsertOrganization(db, clerkOrgId, { name: orgData.name, slug: orgData.slug });
  const user = await userService.getOrCreateByClerkId(db, clerkUserId);
  await orgService.upsertMembership(db, org.id, user.id, orgService.normalizeRole(data.role), data.id ?? null);
  await orgService.revokeMembership(db, org.id, user.id, data.id ?? null);
  await stampEventTime(db, org.id, user.id, at);
}
