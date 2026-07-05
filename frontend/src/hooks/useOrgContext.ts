import { useAuth } from '@clerk/react';

/**
 * Active-organization context derived from the Clerk session (no network call).
 *
 * Clerk puts the active org + role on the session token; `useAuth()` surfaces
 * them as `orgId` / `orgRole` (e.g. "org:admin"). We normalize the role so the
 * UI can gate admin-only views without re-deriving the "org:" prefix everywhere.
 */
export function useOrgContext() {
  const { isSignedIn, orgId, orgRole, orgSlug } = useAuth();
  const role = orgRole ?? null;
  const normalized = role ? role.toLowerCase().replace(/^org:/, '') : null;
  // Super admin: any role ending in "admin". Leader: the "leader" role. These
  // mirror the backend tiers; a leader + admin can both see team analytics.
  const isAdmin = !!normalized && normalized.endsWith('admin');
  const isLeader = normalized === 'leader';
  const canManageTeam = isAdmin || isLeader;
  return {
    isSignedIn: !!isSignedIn,
    inOrg: !!orgId,
    orgId: orgId ?? null,
    orgSlug: orgSlug ?? null,
    role,
    isAdmin,
    isLeader,
    canManageTeam,
  };
}
