import { useQuery } from '@tanstack/react-query';
import { selfServeApi } from '../api/selfServe';
import { useAuth } from '../lib/authClient';

/** /api/v1/config, keyed by user so a sign-in as someone else never reuses another user's flags. */
export function useAppConfig() {
  const { isSignedIn, userId } = useAuth();
  return useQuery({ queryKey: ['app-config', userId], queryFn: () => selfServeApi.config(), enabled: !!isSignedIn, staleTime: 5 * 60 * 1000 });
}
