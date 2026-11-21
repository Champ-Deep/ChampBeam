/** Auto-join by verified company email domain (card t_b2ddf964). */
import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client";
import { orgEmailDomains, organizationMemberships, ROLE_MEMBER, users } from "../db/schema";

/** Mailbox providers anyone can register: listing one would hand the org to the public. */
export const PUBLIC_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "icloud.com", "me.com", "proton.me", "protonmail.com", "aol.com",
]);

/** Exact domain of an address, lowercased; null when it is not a plain `local@domain`. */
export function emailDomain(email: string): string | null {
  const at = email.trim().toLowerCase().split("@");
  return at.length === 2 && at[0] && at[1] ? at[1] : null;
}

/**
 * Join the user to the org that lists their email domain, as `member`.
 * Verified emails only (no mail sender at launch, so a password sign-up proves nothing), exact domain match,
 * and at most once per user: removing a member deletes the row, so only the `org_join_checked_at` marker keeps
 * an admin's removal from being undone at the next sign-in. A user with any membership row (even revoked) never joins.
 */
export async function joinOrgByEmailDomain(db: Db, user: { id: string; email: string; emailVerified: boolean }): Promise<boolean> {
  if (!user.emailVerified) return false;
  const domain = emailDomain(user.email);
  if (!domain) return false;
  const hit = await db.select({ orgId: orgEmailDomains.organizationId }).from(orgEmailDomains).where(eq(orgEmailDomains.domain, domain)).get();
  if (!hit) return false;
  // Claim the one-time check atomically; a concurrent sign-in or an earlier join loses.
  const claimed = await db.update(users).set({ orgJoinCheckedAt: new Date().toISOString() })
    .where(and(eq(users.id, user.id), isNull(users.orgJoinCheckedAt))).returning({ id: users.id });
  if (claimed.length === 0) return false;
  const existing = await db.select({ id: organizationMemberships.id }).from(organizationMemberships).where(eq(organizationMemberships.userId, user.id)).get();
  if (existing) return false;
  await db.insert(organizationMemberships).values({ organizationId: hit.orgId, userId: user.id, role: ROLE_MEMBER }).onConflictDoNothing();
  return true;
}
