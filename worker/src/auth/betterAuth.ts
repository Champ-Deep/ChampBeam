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
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { getSettings, type Env } from "../env";
import { trustedOrigins } from "../lib/cors";
import { joinOrgByEmailDomain } from "../services/emailDomains";

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
      // No email sender at launch (D2 = B): no reset or verification mail.
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
      // Same check in tests as in production (Better Auth skips it under NODE_ENV=test).
      disableOriginCheck: false,
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: () => crypto.randomUUID() },
    },
    databaseHooks: {
      user: {
        create: {
          // Sign-up: a verified (Google) email on a listed company domain joins that org.
          after: async (user) => {
            await joinOrgByEmailDomain(db, user);
          },
        },
      },
      session: {
        create: {
          // First sign-in after verification catches users who signed up unverified. Runs in `before` so a hook that
          // picks the session's active org (release branch) sees the membership; the join itself is once per user.
          before: async (session) => {
            const user = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get();
            if (user) await joinOrgByEmailDomain(db, user);
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
