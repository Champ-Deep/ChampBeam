import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionScope } from './SessionScope';
vi.mock('../lib/authClient', () => ({ useAuth: () => ({ userId: null, orgId: null, isLoaded: false }) }));
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); });
it.each(['/sign-in', '/sign-up', '/forgot-password', '/reset-password'])('keeps %s reachable while session discovery is pending', (path) => {
  history.replaceState(null, '', path);
  render(<SessionScope><label>Public form<input /></label></SessionScope>);
  expect(screen.getByLabelText('Public form')).toBeVisible();
});
it.each(['/files', '/pages', '/settings', '/sign-in-not-public'])('does not bypass session gating for %s', path => {
  history.replaceState(null, '', path);
  render(<SessionScope><p>Private content</p></SessionScope>);
  expect(screen.queryByText('Private content')).toBeNull();
  expect(screen.getByRole('status')).toHaveTextContent('Loading account');
});
