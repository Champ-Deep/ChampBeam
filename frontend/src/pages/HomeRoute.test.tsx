import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../App';

type AuthUser = { id: string; name: string; email: string; image: null };
const auth = vi.hoisted(() => ({
  current: {
    isLoaded: false,
    isSignedIn: false,
    userId: null as string | null,
    orgId: null as string | null,
    user: null as AuthUser | null,
  },
}));

vi.mock('../lib/authClient', () => ({
  useAuth: () => auth.current,
  googleSignInEnabled: false,
  authClient: {
    useListOrganizations: () => ({ data: [], isPending: false, error: null }),
    organization: { setActive: vi.fn() },
    signIn: { email: vi.fn(), social: vi.fn() },
    signUp: { email: vi.fn() },
    signOut: () => Promise.resolve({}),
  },
}));

vi.mock('../api/files', () => ({ filesApi: { list: () => Promise.resolve([]) } }));
vi.mock('../api/pages', () => ({ pagesApi: { list: () => Promise.resolve([]), suggestSlug: () => Promise.resolve({ slug: 'page' }) } }));
vi.mock('../api/utm', () => ({
  utmApi: {
    getLinkPerformance: () => Promise.resolve([]),
    getRecentClicks: () => Promise.resolve([]),
    clearRecentClicks: () => Promise.resolve(),
  },
}));
vi.mock('../api/org', () => ({
  orgApi: {
    profile: () => Promise.resolve({
      user_id: 'user-1',
      full_name: 'Ada Lovelace',
      email: 'ada@example.invalid',
      org: null,
      role: null,
      permissions: ['share.create'],
      report_scope: 'own',
      share_host: { default: 'champbeam.com', default_domain_id: 'dom-1' },
      available_hosts: [{ id: 'dom-1', hostname: 'champbeam.com', org_default: true }],
    }),
  },
}));
vi.mock('../api/champvault', () => ({ champvaultApi: { config: () => Promise.resolve({ configured: false }) } }));
vi.mock('../api/assistant', () => ({ assistantApi: { config: () => Promise.resolve({ enabled: false }), chat: () => Promise.resolve({ reply: '' }) } }));

const member: AuthUser = { id: 'user-1', name: 'Ada Lovelace', email: 'ada@example.invalid', image: null };

function show(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  auth.current = { isLoaded: false, isSignedIn: false, userId: null, orgId: null, user: null };
});

describe('home route', () => {
  it('shows neither screen while the session is loading', () => {
    show('/');
    expect(screen.getByRole('status')).toHaveTextContent('Loading account');
    expect(screen.queryByRole('heading', { name: /Know they saw it/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Share' })).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('shows the landing to a signed-out visitor and keeps them on /', () => {
    auth.current = { isLoaded: true, isSignedIn: false, userId: null, orgId: null, user: null };
    show('/');
    expect(screen.getByRole('heading', { name: /Know they saw it/ })).toBeVisible();
    expect(screen.getByRole('link', { name: /Sign up free/ })).toHaveAttribute('href', '/sign-up');
    expect(screen.getAllByRole('link', { name: 'Sign in' }).every((link) => link.getAttribute('href') === '/sign-in')).toBe(true);
    expect(screen.getByText(/ChampUTM inside/)).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Share' })).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
    expect(screen.queryByText(/Clerk/)).toBeNull();
  });

  it('shows the work screen to a signed-in member and does not bounce to sign-in', async () => {
    auth.current = { isLoaded: true, isSignedIn: true, userId: member.id, orgId: null, user: member };
    show('/');
    expect(screen.getByRole('heading', { name: 'Share' })).toBeVisible();
    expect(await screen.findByRole('heading', { name: 'Drop a file or paste a link' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: /Know they saw it/ })).toBeNull();
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  it('sends a signed-out visitor from a protected route to sign-in, once', () => {
    auth.current = { isLoaded: true, isSignedIn: false, userId: null, orgId: null, user: null };
    show('/links');
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeVisible();
    expect(screen.queryByRole('heading', { name: /Know they saw it/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Share' })).toBeNull();
  });

  it('sends a signed-in member from sign-in back to the work screen, once', () => {
    auth.current = { isLoaded: true, isSignedIn: true, userId: member.id, orgId: null, user: member };
    show('/sign-in');
    expect(screen.getByRole('heading', { name: 'Share' })).toBeVisible();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Know they saw it/ })).toBeNull();
  });
});
