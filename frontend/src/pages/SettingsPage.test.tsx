import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../components/ui';
import { SettingsPage } from './SettingsPage';

const ctx = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../hooks/useOrgContext', () => ({ useOrgContext: () => ctx.value }));
vi.mock('../lib/authClient', () => ({ useAuth: () => ({ userId: 'u1', orgId: null }) }));
vi.mock('../api/system', () => ({ systemApi: { access: vi.fn().mockResolvedValue({ is_admin: false }) } }));
vi.mock('../api/utm', () => ({ utmApi: { getDomainsConfig: vi.fn().mockResolvedValue({}), listDomains: vi.fn().mockResolvedValue([]) } }));
vi.mock('../components/OrganizationSettings', () => ({ OrganizationSettings: () => null }));
vi.mock('../components/AppearanceSettings', () => ({ AppearanceSettings: () => null }));

const base = { isLoading: false, error: null, permissions: [] as string[], inOrg: false, profile: undefined };
beforeEach(() => { ctx.value = base; });
afterEach(cleanup);

function mount() {
  return render(<QueryClientProvider client={new QueryClient()}><MemoryRouter initialEntries={['/settings']}><ConfirmProvider><SettingsPage /></ConfirmProvider></MemoryRouter></QueryClientProvider>);
}
const names = (group: HTMLElement) => within(group).getAllByRole('button').map((b) => b.textContent);

it('without an org, everything is under Personal', () => {
  mount();
  const personal = screen.getByRole('group', { name: 'Personal' });
  expect(names(personal)).toEqual(['Appearance', 'Notifications', 'API keys and agents', 'Domains', 'Assistant settings']);
  expect(screen.getAllByRole('group')).toHaveLength(1);
});

it('org admin gets a second group headed by the org name', () => {
  ctx.value = { ...base, inOrg: true, permissions: ['org.domains.manage'], profile: { org: { id: 'o1', name: 'LakeB2B', slug: 'lakeb2b' } } };
  mount();
  expect(names(screen.getByRole('group', { name: 'Personal' }))).toEqual(['Appearance', 'Notifications', 'API keys and agents']);
  expect(names(screen.getByRole('group', { name: 'LakeB2B' }))).toEqual(['Workspace administration', 'Domains', 'Assistant settings']);
});

it('member without domain permission does not see Domains, and keeps API keys under Personal', () => {
  ctx.value = { ...base, inOrg: true, permissions: [], profile: { org: { id: 'o1', name: 'LakeB2B', slug: 'lakeb2b' } } };
  mount();
  expect(names(screen.getByRole('group', { name: 'LakeB2B' }))).toEqual(['Workspace administration', 'Assistant settings']);
  expect(within(screen.getByRole('group', { name: 'Personal' })).getByRole('button', { name: 'API keys and agents' })).toBeVisible();
});
