/**
 * Small helpers shared by the org-scoped routers (org, content, rooms,
 * champvault). These lived inline in each Python router module.
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { organizations } from "../db/schema";
import { httpError } from "../lib/errors";
import type { TokenData } from "../auth/security";

export type Organization = typeof organizations.$inferSelect;

export const NOT_PROVISIONED = "Organization is not provisioned yet. Retry shortly.";

/** Python `UUID(value)`: hyphens optional, braces / urn prefix, any case -> canonical, else null. */
export function pyUuid(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  let v = value.trim().toLowerCase();
  if (v.startsWith("urn:uuid:")) v = v.slice(9);
  v = v.replace(/^\{(.*)\}$/, "$1").replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(v)) return null;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20)}`;
}

/** The caller's active org row; 409 when the local mirror hasn't been created yet. */
export async function orgForUser(db: Db, user: TokenData): Promise<Organization> {
  const org = await db
    .select()
    .from(organizations)
    .where(eq(organizations.clerkOrgId, user.orgId ?? ""))
    .get();
  if (!org) httpError(409, NOT_PROVISIONED);
  return org;
}

/** Local org UUID for the caller (org_service.resolve_org_uuid + 409). */
export async function orgUuidForUser(db: Db, user: TokenData): Promise<string> {
  return (await orgForUser(db, user)).id;
}

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith("@clerk.placeholder");
}
