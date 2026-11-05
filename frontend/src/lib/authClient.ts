import { createAuthClient } from 'better-auth/react';
import { organizationClient } from 'better-auth/client/plugins';

// Same origin: the Worker serves /api/auth next to the SPA, and the session rides in an HttpOnly cookie.
export const authClient = createAuthClient({ plugins: [organizationClient()] });

// Google shows only when the build carries the public client id the Worker is configured with.
export const googleSignInEnabled = Boolean((import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined)?.trim());

/** The session fields the app reads. orgId is null in the personal workspace. */
export function useAuth() {
  const { data, isPending } = authClient.useSession();
  return {
    isLoaded: !isPending,
    isSignedIn: !!data,
    userId: data?.user.id ?? null,
    orgId: data?.session.activeOrganizationId ?? null,
    user: data?.user ?? null,
  };
}
