import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';
import { SessionScope } from '../components/SessionScope';

const auth = vi.hoisted(() => ({ isSignedIn: false, isLoaded: false, userId: null, orgId: null }));
vi.mock('../lib/authClient', () => ({ useAuth: () => auth }));
vi.mock('../hooks/useShareLists', () => ({ useShareLists: () => {
  const empty = { data: [], isLoading: false, error: null, refetch: vi.fn() };
  return { files: empty, pages: empty, links: empty };
} }));
vi.mock('../components/ShareComposer', () => ({ ShareComposer: () => <p>Workspace composer</p> }));

beforeEach(() => {
  auth.isSignedIn = false;
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  vi.stubGlobal('matchMedia', () => ({ matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('renders the actual public landing through SessionScope while home session discovery is pending', () => {
  render(<MemoryRouter><SessionScope><HomePage /></SessionScope></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Share with ChampBeam' })).toBeVisible();
  expect(screen.getByRole('tab', { name: /^Files/ })).toBeVisible();
  expect(screen.getByText('Sample data', { exact: true })).toBeVisible();
  expect(screen.queryByTestId('account-skeleton')).not.toBeInTheDocument();
  expect(screen.queryByText('Opening your workspace')).not.toBeInTheDocument();
});

it('mounts the decorative globe only for signed-out visitors and preserves the signed-in workspace', () => {
  auth.isSignedIn = false;
  const view = render(<MemoryRouter><HomePage /></MemoryRouter>);
  expect(view.container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getAllByRole('link', { name: 'Sign in' })[0]).toHaveAttribute('href', '/sign-in');
  expect(screen.getAllByRole('link', { name: 'Sign up' })[0]).toHaveAttribute('href', '/sign-up');
  expect(screen.queryByText('Workspace composer')).not.toBeInTheDocument();
  auth.isSignedIn = true;
  view.rerender(<MemoryRouter><HomePage /></MemoryRouter>);
  expect(view.container.querySelector('canvas')).toBeNull();
  expect(screen.getByText('Workspace composer')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Recent shares' })).toBeInTheDocument();
});
