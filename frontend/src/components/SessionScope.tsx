import { useEffect, useState, type ReactNode } from 'react';
import { useAuth } from '@clerk/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setTokenGetter } from '../api/client';

function SessionCache({ children }: { children: ReactNode }) {
  const { getToken } = useAuth();
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 60_000, retry: 1 } } }));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setTokenGetter(() => getToken());
    queueMicrotask(() => setReady(true));
    return () => { client.clear(); };
  }, [client, getToken]);
  return ready ? <QueryClientProvider client={client}>{children}</QueryClientProvider> : <p role="status">Loading workspace…</p>;
}

export function SessionScope({ children }: { children: ReactNode }) {
  const { userId, orgId, isLoaded } = useAuth();
  if (!isLoaded) return <p role="status">Loading account…</p>;
  // A fresh tree also discards draft content and late responses from the previous workspace.
  return <SessionCache key={`${userId ?? 'guest'}:${orgId ?? 'personal'}`}>{children}</SessionCache>;
}
