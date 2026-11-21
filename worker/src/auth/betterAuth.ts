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
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { verifyPassword } from "better-auth/crypto";
import { organization } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/organization/access";
import bcrypt from "bcryptjs";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { getSettings, type Env } from "../env";
import { trustedOrigins } from "../lib/cors";
import { sendMail } from "../lib/email";

/** The one org every user belongs to (Deep's ruling, 5 Nov). New sign-ups join it as `member`. */
export const DEFAULT_ORG_SLUG = "champions-group";

const ac = createAccessControl(defaultStatements);
const roles = {
  // No organization:update: the default org is found by its slug, so a rename through this API would redirect every sign-up.
  admin: ac.newRole({
    member: ["create", "update", "delete"],
    invitation: ["create", "cancel"],
  }),
  leader: ac.newRole({}),
  member: ac.newRole({}),
  viewer: ac.newRole({}),
};

/** Only a verified address on an allowlisted company domain joins the shared org; anyone else starts in Personal and is added by an org admin. */
export function joinsDefaultOrg(settings: { autoJoinEmailDomains: string[] }, u: { email: string; emailVerified?: boolean | null }): boolean {
  return u.emailVerified === true && settings.autoJoinEmailDomains.includes(u.email.slice(u.email.lastIndexOf("@") + 1).toLowerCase());
}

export function createAuth(env: Env, db: Db, waitUntil?: (p: Promise<unknown>) => void) {
  const settings = getSettings(env);
  const google = settings.googleClientId && settings.googleClientSecret;
  // An email failure must never fail the reset request that triggered it (and must not reveal which emails exist).
  const mail = async (to: string, subject: string, body: string, linkLabel: string, url: string): Promise<void> => {
    try {
      const res = await sendMail(env, settings, { to, subject, body, linkLabel, url });
      // Delivery result only (message id / recipient lists), never the link.
      console.log(`email \"${subject}\" result`, JSON.stringify(res ?? null));
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
      accountLinking: { enabled: true, requireLocalEmailVerified: true },
    },
    emailAndPassword: {
      enabled: true,
      // Reset only exists when the Email binding does. Migrated Clerk users have no credential row: a reset gives them one.
      sendResetPassword: settings.emailEnabled
        ? async ({ user, url }) => mail(user.email, "Reset your ChampBeam password", "Use this link to choose a new password. It expires in one hour.", "Reset password", url)
        : undefined,
      // A reset must end every session opened before it (a pre-registered or stolen session must not survive recovery).
      revokeSessionsOnPasswordReset: true,
      // Recovery also ends the user's API keys: a key minted from a stolen session must not outlive the reset.
      onPasswordReset: async ({ user }) => {
        await db.update(schema.apiKeys).set({ revokedAt: new Date().toISOString() })
          .where(and(eq(schema.apiKeys.userId, user.id), isNull(schema.apiKeys.revokedAt)));
      },
      password: {
        // Imported Clerk hashes are bcrypt; everything Better Auth writes is its default scrypt.
        verify: ({ hash, password }) => (hash.startsWith("$2") ? bcrypt.compare(password, hash) : verifyPassword({ hash, password })),
      },
    },
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
      // Send mail after the response: awaiting it would make a known address slower than an unknown one.
      ...(waitUntil ? { backgroundTasks: { handler: waitUntil } } : {}),
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
      user: {
        create: {
          // service+<name>@ rows are provisioned by the operator for X-Service-Key; a self-registration must not claim one.
          before: async (user) => (/^service\+/i.test(user.email) ? false : undefined),
          after: async (user) => {
            // Open sign-up: an unverified or off-domain address must not land inside the shared org.
            if (!joinsDefaultOrg(settings, user)) return;
            const org = await db
              .select({ id: schema.organizations.id })
              .from(schema.organizations)
              .where(eq(schema.organizations.slug, DEFAULT_ORG_SLUG))
              .get();
            if (!org) {
              console.warn(`auth: no '${DEFAULT_ORG_SLUG}' org, new user ${user.id} joined no org`);
              return;
            }
            await db
              .insert(schema.organizationMemberships)
              .values({ organizationId: org.id, userId: user.id, role: schema.ROLE_MEMBER })
              .onConflictDoNothing();
          },
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "admin",
        allowUserToCreateOrganization: false,
        // Explicit, not a side effect of the custom generateId: an unverified sign-up must not accept an invitation addressed to someone else.
        requireEmailVerificationOnInvitation: true,
        organizationHooks: {
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
