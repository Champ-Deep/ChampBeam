import { useAuth } from '../lib/authClient';
import { useQuery } from '@tanstack/react-query';
import { orgApi } from '../api/org';

// The session selects the workspace; only the server profile grants capabilities.
export function useOrgContext() {
  const { isSignedIn, orgId, userId } = useAuth();
  const query = useQuery({
    queryKey: ['org-profile', userId, orgId],
    queryFn: () => orgApi.profile(),
    enabled: !!isSignedIn,
    retry: false,
  });
  const profile = query.error ? undefined : query.data;
  const permissions = profile?.permissions ?? [];
  const isAdmin = permissions.includes('org.members.manage');
  const canManageTeam = permissions.includes('team.manage');
  return {
    isSignedIn: !!isSignedIn,
    inOrg: !!orgId,
    orgId: orgId ?? null,
    orgSlug: profile?.org?.slug ?? null,
    role: profile?.role ?? null,
    isAdmin,
    isLeader: canManageTeam && !isAdmin,
    canManageTeam,
    canReport: !!profile && profile.report_scope !== 'none',
    canShare: !!profile && (!orgId || permissions.includes('share.create')),
    profile,
    permissions,
    isLoading: query.isLoading,
    error: query.error,
    refetch: query.refetch,
  };
}
