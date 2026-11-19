import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HomePage } from './HomePage';

const auth = vi.hoisted(() => ({ isSignedIn: false }));
vi.mock('../lib/authClient', () => ({ useAuth: () => auth }));
vi.mock('../hooks/useShareLists', () => ({ useShareLists: () => {
  const empty = { data: [], isLoading: false, error: null, refetch: vi.fn() };
  return { files: empty, pages: empty, links: empty };
} }));
vi.mock('../components/ShareComposer', () => ({ ShareComposer: () => <p>Workspace composer</p> }));

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

it('mounts the decorative globe only for signed-out visitors and preserves the signed-in workspace', () => {
  auth.isSignedIn = false;
  const view = render(<MemoryRouter><HomePage /></MemoryRouter>);
  expect(view.container.querySelector('canvas')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/sign-in');
  expect(screen.getByRole('link', { name: 'Sign up' })).toHaveAttribute('href', '/sign-up');
  expect(screen.queryByText('Workspace composer')).not.toBeInTheDocument();
  auth.isSignedIn = true;
  view.rerender(<MemoryRouter><HomePage /></MemoryRouter>);
  expect(view.container.querySelector('canvas')).toBeNull();
  expect(screen.getByText('Workspace composer')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Recent shares' })).toBeInTheDocument();
});
