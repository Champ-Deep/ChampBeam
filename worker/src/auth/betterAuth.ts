/**
 * Better Auth on D1 (docs/BETTER-AUTH-PRD.md section 4, amended by Deep on t_fca02bea).
 *
 * Better Auth owns sign-in, sessions (D1 `session` table, cookie `champbeam.session_token`)
 * and org membership management. It writes straight into our users / organizations /
 * organization_memberships tables, so every users.id and org id stays what it was.
 * permissions.ts stays the only authority for ChampBeam features; the Better Auth roles
 * below gate only Better Auth's own org-management endpoints.
 */
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { verifyPassword } from "better-auth/crypto";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import bcrypt from "bcryptjs";
import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { getSettings, type Env } from "../env";
import { trustedOrigins } from "../lib/cors";
import { sendMail } from "../lib/email";
import { slugProblem } from "../services/orgSlug";
import { hasGoogleAccount, isSuperAdmin } from "./superAdmin";

/** Orgs one user may administer (create or be promoted in). Super admins are exempt. */
export const MAX_ORGS_PER_USER = 5;
const INVITE_TTL_SECONDS = 7 * 86_400;

/** The accept page lives on the platform host, never on a custom domain. */
export const inviteUrl = (settings: { platformOrigin: string }, invitationId: string) => `${settings.platformOrigin}/accept-invitation/${invitationId}`;

const ac = createAccessControl(defaultStatements);
const roles = {
  admin: ac.newRole({
    organization: ["update"],
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  leader: ac.newRole({}),
  member: ac.newRole({}),
  viewer: ac.newRole({}),
};

export function createAuth(env: Env, db: Db) {
  const settings = getSettings(env);
  const google = settings.googleClientId && settings.googleClientSecret;
  // An email failure must never fail the sign-up, reset or invite that triggered it.
  const mail = async (to: string, subject: string, body: string, linkLabel: string, url: string): Promise<void> => {
    try {
      await sendMail(env, settings, { to, subject, body, linkLabel, url });
    } catch (err) {
      console.error(`email "${subject}" failed`, err);
    }
  };
  return betterAuth({
    appName: settings.appName,
    baseURL: settings.betterAuthUrl,
    secret: settings.betterAuthSecret,
    trustedOrigins: trustedOrigins(settings),
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema: {
        users: schema.users,
        organizations: schema.organizations,
        organization_memberships: schema.organizationMemberships,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
        invitation: schema.invitation,
        rateLimit: schema.rateLimit,
      },
    }),
    user: {
      modelName: "users",
      fields: { name: "fullName" },
      additionalFields: {
        clerkId: { type: "string", required: false, input: false },
        isActive: { type: "boolean", required: false, input: false, defaultValue: true },
      },
    },
    session: {
      expiresIn: 7 * 86_400,
      updateAge: 86_400,
      // Off: a revoked session or membership must die on the next request.
      cookieCache: { enabled: false },
    },
    account: {
      // Links a Google sign-in to an existing users row only when Google says the email is verified.
      accountLinking: { enabled: true },
    },
    emailAndPassword: {
      enabled: true,
      // Reset only exists when the Email binding does; the UI reads email_enabled and hides "Forgot password" otherwise.
      sendResetPassword: settings.emailEnabled
        ? async ({ user, url }) => mail(user.email, "Reset your ChampBeam password", "Use this link to choose a new password. It expires in one hour.", "Reset password", url)
        : undefined,
      password: {
        // Imported Clerk hashes are bcrypt; everything Better Auth writes is its default scrypt.
        verify: ({ hash, password }) => (hash.startsWith("$2") ? bcrypt.compare(password, hash) : verifyPassword({ hash, password })),
      },
    },
    // Verification mail goes out at password sign-up. Sign-in is not blocked on it: a personal workspace
    // works unverified, while creating an org (below) and accepting an invite (with email on) need it.
    emailVerification: settings.emailEnabled
      ? {
          sendOnSignUp: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: async ({ user, url }) => mail(user.email, "Verify your email for ChampBeam", "Confirm this address to finish setting up your ChampBeam account.", "Verify email", url),
        }
      : undefined,
    socialProviders: google
      ? { google: { clientId: settings.googleClientId, clientSecret: settings.googleClientSecret } }
      : {},
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { "/sign-in/*": { window: 60, max: 5 } },
    },
    advanced: {
      cookiePrefix: "champbeam",
      // Same check in tests as in production (Better Auth skips it under NODE_ENV=test).
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: () => crypto.randomUUID() },
    },
    databaseHooks: {
      session: {
        create: {
          // Land members in their org instead of Personal: oldest active membership becomes the session's org.
          before: async (session) => {
            const m = await db
              .select({ orgId: schema.organizationMemberships.organizationId })
              .from(schema.organizationMemberships)
              .where(and(eq(schema.organizationMemberships.userId, session.userId), eq(schema.organizationMemberships.status, "active")))
              .orderBy(asc(schema.organizationMemberships.createdAt))
              .get();
            return { data: { ...session, activeOrganizationId: m?.orgId ?? null } };
          },
        },
      },
      // Personal by default: a new user belongs to no org until they create one or accept an invite.
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "admin",
        // Verified email or Google sign-in. Cap: MAX_ORGS_PER_USER orgs administered, super admins exempt.
        allowUserToCreateOrganization: async (user) => !!user.emailVerified || (await hasGoogleAccount(db, user.id)),
        organizationLimit: async (user) => {
          if (await isSuperAdmin(db, settings, user)) return false;
          const n = await db
            .select({ n: count() })
            .from(schema.organizationMemberships)
            .where(and(eq(schema.organizationMemberships.userId, user.id), eq(schema.organizationMemberships.role, schema.ROLE_ADMIN), eq(schema.organizationMemberships.status, "active")))
            .get();
          return (n?.n ?? 0) >= MAX_ORGS_PER_USER;
        },
        invitationExpiresIn: INVITE_TTL_SECONDS,
        // Better Auth's default cap is 100 members per org.
        membershipLimit: 5000,
        // shortcut: with no Email binding the unguessable invite link is the secret, so an unverified
        // account may accept it (the accept call still requires the session email to equal the invited
        // email). Upgrade when email lands: this flips to true as soon as the binding exists.
        requireEmailVerificationOnInvitation: settings.emailEnabled,
        sendInvitationEmail: settings.emailEnabled
          ? async (d) =>
              mail(d.email, `${d.inviter.user.name || d.inviter.user.email} invited you to ${d.organization.name} on ChampBeam`, `You were invited to join ${d.organization.name} as ${d.role}. The invitation expires in 7 days.`, "Accept invitation", inviteUrl(settings, d.id))
          : undefined,
        organizationHooks: {
          beforeCreateOrganization: async ({ organization }) => {
            const why = slugProblem(organization.slug);
            if (why) throw new APIError("BAD_REQUEST", { message: why });
          },
          beforeUpdateOrganization: async ({ organization }) => {
            if (organization.slug === undefined) return;
            const why = slugProblem(organization.slug);
            if (why) throw new APIError("BAD_REQUEST", { message: why });
          },
          // Removing a member deletes the row; also end their reporting grants, as the Clerk revoke did.
          afterRemoveMember: async ({ member }) => {
            await db
              .update(schema.reportingGrants)
              .set({ revokedAt: new Date().toISOString() })
              .where(
                and(
                  eq(schema.reportingGrants.organizationId, member.organizationId),
                  eq(schema.reportingGrants.userId, member.userId),
                  isNull(schema.reportingGrants.revokedAt),
                ),
              );
          },
        },
        schema: {
          organization: { modelName: "organizations" },
          member: { modelName: "organization_memberships" },
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
