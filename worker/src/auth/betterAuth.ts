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
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import * as schema from "../db/schema";
import { getSettings, type Env } from "../env";
import { trustedOrigins } from "../lib/cors";
import { INTRANET_DISABLED_AUTH_PATHS, intranetAcceptInvite, intranetCheckSignup } from "../intranet/invites";
import { joinOrgByEmailDomain } from "../services/emailDomains";
import { sendMail } from "../lib/email";
import { slugProblem } from "../services/orgSlug";
import { isSuperAdmin } from "./superAdmin";

const INVITE_TTL_SECONDS = 7 * 86_400;

/** The accept page lives on the platform host, never on a custom domain. */
export const inviteUrl = (settings: { platformOrigin: string }, invitationId: string) => `${settings.platformOrigin}/accept-invitation/${invitationId}`;

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

/** The shared org that verified allowlisted addresses join on sign-up. */
export const DEFAULT_ORG_SLUG = "champions-group";

/** Only a verified address on an allowlisted company domain joins the shared org; anyone else starts in Personal and is added by an org admin. */
export function joinsDefaultOrg(settings: { autoJoinEmailDomains: string[] }, u: { email: string; emailVerified?: boolean | null }): boolean {
  return u.emailVerified === true && settings.autoJoinEmailDomains.includes(u.email.slice(u.email.lastIndexOf("@") + 1).toLowerCase());
}

export interface AuthOptions {
  /** Intranet: the invite this request redeems (intranet accept route). Only then may an email sign-up create a user. */
  inviteEmail?: string;
}

export function createAuth(env: Env, db: Db, waitUntil?: (p: Promise<unknown>) => void, opts: AuthOptions = {}) {
  const settings = getSettings(env);
  const intranet = settings.intranetMode;
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
    // Intranet: accounts only through an invite (ACC-1 to ACC-3), membership changes only through the logged intranet API.
    disabledPaths: intranet ? INTRANET_DISABLED_AUTH_PATHS : [],
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
            // First sign-in after verification catches users who signed up unverified; join before the org is picked below.
            const person = await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).get();
            if (person) await joinOrgByEmailDomain(db, person);
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
          before: async (user, ctx) => {
            // service+<name>@ rows are provisioned by the operator for X-Service-Key; a self-registration must not claim one.
            if (/^service\+/i.test(user.email)) return false;
            if (!intranet) return;
            const refusal = await intranetCheckSignup(env.DB, String(user.email ?? ""), ctx?.path ?? null, opts.inviteEmail ?? null);
            if (refusal) throw new APIError("FORBIDDEN", { message: refusal });
          },
          after: async (user) => {
            if (intranet) {
              await intranetAcceptInvite(env.DB, user.id, String(user.email ?? ""));
              return;
            }
            // Open sign-up: an unverified or off-domain address must not land inside the shared org.
            // An env-allowlisted domain (Deep's ruling: championsmail.com, lakeb2b.com) joins the shared org at creation; any other
            // verified address falls through to the admin-managed list (PR #61), which joins at most once per user.
            if (!joinsDefaultOrg(settings, user)) {
              await joinOrgByEmailDomain(db, user);
              return;
            }
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
            // Same once-only marker the admin-managed join uses: a later admin removal must not be undone by a sign-in join.
            await db.update(schema.users).set({ orgJoinCheckedAt: new Date().toISOString() }).where(eq(schema.users.id, user.id));
          },
        },
      },
    },
    plugins: [
      organization({
        ac,
        roles,
        creatorRole: "admin",
        // Deep's ruling (6 Nov): only super admins create orgs. A paid tier later widens this one line.
        allowUserToCreateOrganization: (user) => isSuperAdmin(db, settings, user),
        invitationExpiresIn: INVITE_TTL_SECONDS,
        // Better Auth's default cap is 100 members per org.
        membershipLimit: 5000,
        // Explicit, not a side effect of the custom generateId: an unverified sign-up must not accept an invitation addressed to someone else (audit run-5).
        requireEmailVerificationOnInvitation: true,
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
