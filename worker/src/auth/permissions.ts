/**
 * Explicit org permission map. Replaces the old `role.endsWith("admin")` test:
 * a role grants exactly the permissions listed here and nothing else, so a new
 * or custom Clerk role ("billing_admin", "viewer") can never become admin by
 * name. Unknown roles fall back to MEMBER (least privilege that still works).
 *
 * Reporting visibility is NOT a role. A "viewer" is any member holding a
 * reporting grant (see reporting_grants); the grant carries read-only report
 * rights and no write or secret right.
 */
export type Permission =
  | "share.create" // create files / pages / links under the active org
  | "report.own" // read reporting on own items
  | "report.team" // read reporting on assigned teams
  | "report.org" // read reporting across the whole org
  | "team.manage" // assign content to reps
  | "org.members.manage" // set leaders, invite/remove (mirrors Clerk)
  | "org.domains.manage" // connect, verify, default org domains
  | "org.viewers.grant"; // create / revoke reporting grants

const MEMBER: readonly Permission[] = ["share.create", "report.own"];
const LEADER: readonly Permission[] = [...MEMBER, "report.team", "team.manage"];
const ADMIN: readonly Permission[] = [
  ...LEADER,
  "report.org",
  "org.members.manage",
  "org.domains.manage",
  "org.viewers.grant",
];
// A viewer-only seat: no writes. Reporting comes from grants, not from here.
const VIEWER: readonly Permission[] = [];

const ROLE_PERMISSIONS: Readonly<Record<string, readonly Permission[]>> = {
  admin: ADMIN,
  org_admin: ADMIN,
  super_admin: ADMIN,
  leader: LEADER,
  member: MEMBER,
  viewer: VIEWER,
};

/** Normalized role -> permissions. Unknown roles get MEMBER, never admin. */
export function permissionsForRole(role: string | null | undefined): ReadonlySet<Permission> {
  const r = (role ?? "").trim().toLowerCase();
  return new Set(ROLE_PERMISSIONS[r] ?? MEMBER);
}

export const roleHas = (role: string | null | undefined, p: Permission): boolean => permissionsForRole(role).has(p);
