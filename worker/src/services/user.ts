/** Port of backend/app/services/user_service.py. */
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { users } from "../db/schema";
import { nowIso } from "../lib/time";

export type User = typeof users.$inferSelect;

export async function getByEmail(db: Db, email: string): Promise<User | undefined> {
  return db.select().from(users).where(eq(users.email, email)).get();
}

export async function getById(db: Db, userId: string): Promise<User | undefined> {
  return db.select().from(users).where(eq(users.id, userId)).get();
}

export function hasPlaceholderEmail(user: Pick<User, "email">): boolean {
  return !!user.email && user.email.endsWith("@clerk.placeholder");
}

/**
 * Fill in real email/name from Clerk, overwriting only the placeholder.
 * Skips an email already taken by another row (unique constraint).
 */
export async function applyIdentity(
  db: Db,
  user: User,
  opts: { email?: string | null; fullName?: string | null },
): Promise<boolean> {
  const patch: Partial<User> = {};
  if (opts.email && hasPlaceholderEmail(user) && opts.email !== user.email) {
    const clash = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, opts.email), ne(users.id, user.id)))
      .get();
    if (!clash) patch.email = opts.email;
  }
  if (opts.fullName && !user.fullName) patch.fullName = opts.fullName;
  if (Object.keys(patch).length === 0) return false;
  patch.updatedAt = nowIso();
  await db.update(users).set(patch).where(eq(users.id, user.id));
  Object.assign(user, patch);
  return true;
}

/**
 * Look up a user by Clerk id, creating a stub row on first auth. Race-safe via
 * INSERT .. ON CONFLICT DO NOTHING + re-select (the Python IntegrityError path).
 */
export async function getOrCreateByClerkId(db: Db, clerkId: string): Promise<User> {
  const existing = await db.select().from(users).where(eq(users.clerkId, clerkId)).get();
  if (existing) return existing;
  const now = nowIso();
  await db
    .insert(users)
    .values({
      id: crypto.randomUUID(),
      clerkId,
      email: `${clerkId}@clerk.placeholder`,
      isActive: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const row = await db.select().from(users).where(eq(users.clerkId, clerkId)).get();
  if (!row) throw new Error(`failed to create user for ${clerkId}`);
  return row;
}
