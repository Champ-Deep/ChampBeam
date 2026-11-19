import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useAuth } from '../lib/authClient';
import { AccountLoading } from './AccountLoading';

function SessionCache({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  useEffect(() => () => { client.clear(); }, [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function SessionScope({ children }: { children: ReactNode }) {
  const { userId, orgId, isLoaded } = useAuth();
  // Public auth forms must remain reachable even when session discovery stalls.
  const authPage = /^\/(sign-in|sign-up|forgot-password|reset-password)(\/|$)/.test(window.location.pathname);
  const [hadSession] = useState(() => {
    try { return localStorage.getItem('cb_signed_in') === '1'; } catch { return false; }
  });
  useEffect(() => {
    if (!isLoaded) return;
    try {
      if (userId) localStorage.setItem('cb_signed_in', '1');
      else localStorage.removeItem('cb_signed_in');
    } catch { /* Storage may be unavailable. The hint never grants access. */ }
  }, [isLoaded, userId]);
  if (!isLoaded && !authPage && (window.location.pathname !== '/' || hadSession)) return <AccountLoading />;
  // A fresh tree also discards draft content and late responses from the previous workspace.
  return <SessionCache key={`${userId ?? 'guest'}:${orgId ?? 'personal'}`}>{children}</SessionCache>;
}
