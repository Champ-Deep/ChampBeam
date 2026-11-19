import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SessionScope } from './SessionScope';

const auth = vi.hoisted(() => ({ isLoaded: false, userId: null as string | null, orgId: null }));
vi.mock('../lib/authClient', () => ({ useAuth: () => auth }));

beforeEach(() => { localStorage.clear(); auth.isLoaded = false; auth.userId = null; window.history.replaceState(null, '', '/'); });
afterEach(() => { vi.useRealTimers(); window.history.replaceState(null, '', '/'); });

it('renders the public landing immediately on pending home without a hint', () => {
  render(<SessionScope><h1>Share with ChampBeam</h1></SessionScope>);
  expect(screen.getByRole('heading', { name: 'Share with ChampBeam' })).toBeVisible();
  expect(screen.queryByText('Opening your workspace')).not.toBeInTheDocument();
  expect(screen.queryByTestId('account-skeleton')).not.toBeInTheDocument();
});

it('renders the sidebar dashboard skeleton on pending home with a hint, with slow recovery', () => {
  vi.useFakeTimers(); localStorage.setItem('cb_signed_in', '1');
  render(<SessionScope><h1>Private workspace</h1></SessionScope>);
  expect(screen.getByTestId('account-skeleton')).toBeVisible();
  expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  expect(screen.queryByText('Opening your workspace')).not.toBeInTheDocument();
  expect(screen.queryByText('Checking your session for Files and Pages.')).not.toBeInTheDocument();
  expect(screen.getByRole('status')).toHaveClass('sr-only');
  expect(screen.queryByText('Private workspace')).not.toBeInTheDocument();
  act(() => vi.advanceTimersByTime(12_000));
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeEnabled();
  expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute('href', '/sign-in');
});

it('sets only a non-sensitive hint on sign in and removes it when signed out', () => {
  auth.isLoaded = true; auth.userId = 'synthetic-user';
  const view = render(<SessionScope><p>Content</p></SessionScope>);
  expect(localStorage.getItem('cb_signed_in')).toBe('1');
  auth.userId = null;
  view.rerender(<SessionScope><p>Content</p></SessionScope>);
  expect(localStorage.getItem('cb_signed_in')).toBeNull();
});

it('bypasses pending auth forms even with a stale hint', () => {
  window.history.replaceState(null, '', '/sign-in'); localStorage.setItem('cb_signed_in', '1');
  render(<SessionScope><label>Email<input /></label></SessionScope>);
  expect(screen.getByRole('textbox', { name: 'Email' })).toBeVisible();
  expect(screen.queryByTestId('account-skeleton')).not.toBeInTheDocument();
});

it('does not remount a resolved guest form', () => {
  auth.isLoaded = true;
  const view = render(<SessionScope><label>Email<input /></label></SessionScope>);
  const input = screen.getByLabelText('Email');
  fireEvent.change(input, { target: { value: 'guest@example.invalid' } });
  view.rerender(<SessionScope><label>Email<input /></label></SessionScope>);
  expect(screen.getByLabelText('Email')).toBe(input);
  expect(input).toHaveValue('guest@example.invalid');
});
