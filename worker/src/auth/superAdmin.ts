/**
 * Platform super admin: an email in SUPER_ADMIN_EMAILS that is also verified or Google-linked, so
 * signing up with the address (password, unverified) never grants anything.
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { account } from "../db/schema";
import type { Settings } from "../env";

export async function hasGoogleAccount(db: Db, userId: string): Promise<boolean> {
  const row = await db
    .select({ id: account.id })
    .from(account)
    .where(and(eq(account.userId, userId), eq(account.providerId, "google")))
    .get();
  return !!row;
}

export async function isSuperAdmin(
  db: Db,
  settings: Settings,
  user: { id: string; email?: string | null; emailVerified?: boolean | null },
): Promise<boolean> {
  if (!user.email || !settings.superAdminEmails.has(user.email.toLowerCase())) return false;
  return !!user.emailVerified || (await hasGoogleAccount(db, user.id));
}
