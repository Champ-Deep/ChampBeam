import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountFooter } from './AccountFooter';
import { ReportingSummary } from './ReportingSummary';
import { OrganizationSettings } from './OrganizationSettings';
import { SessionScope } from './SessionScope';
import { useOrgContext } from '../hooks/useOrgContext';
import { orgApi, type Profile } from '../api/org';
import { ConfirmProvider } from './ui/ConfirmDialog';

const fixture = vi.hoisted(() => ({ orgId: 'org-a', imageUrl: '/bad-avatar', openUserProfile: vi.fn(), signOut: vi.fn(), getToken: vi.fn(async () => 'fixture-token') }));
vi.mock('@clerk/react', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: 'clerk-user', orgId: fixture.orgId, orgSlug: fixture.orgId, orgRole: 'org:admin', getToken: fixture.getToken }),
  useUser: () => ({ isLoaded: true, user: { fullName: 'Fixture Member', imageUrl: fixture.imageUrl } }),
  useClerk: () => ({ openUserProfile: fixture.openUserProfile, signOut: fixture.signOut }),
  OrganizationSwitcher: () => null,
}));
vi.mock('../api/org', () => ({ orgApi: { profile: vi.fn(), reporting: vi.fn(), domains: vi.fn(), listMembers: vi.fn(), viewers: vi.fn(), attachDomain: vi.fn() } }));
vi.mock('../api/utm', () => ({ utmApi: { listDomains: vi.fn(async () => []) } }));
const profile: Profile = { user_id: 'db-user', full_name: 'Fixture Member', email: null, org: { id: 'org-a', name: 'Fixture workspace', slug: 'org-a' }, role: 'viewer', permissions: [], report_scope: 'org', share_host: { default: 'fixture.invalid', default_domain_id: null }, available_hosts: [] };
const report = { scope: 'org' as const, totals: { shares_created: 4, opens: 9, clicks: 2 }, by_kind: {}, by_member: [], emails_sent: { status: 'not_measured' as const, count: null, note: 'No email transport evidence.' } };
function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(<QueryClientProvider client={client}><MemoryRouter><ConfirmProvider>{ui}</ConfirmProvider></MemoryRouter></QueryClientProvider>);
  return { ...result, client };
}
beforeEach(() => {
  vi.clearAllMocks(); fixture.orgId = 'org-a'; fixture.imageUrl = '/bad-avatar';
  vi.mocked(orgApi.profile).mockResolvedValue(profile);
  vi.mocked(orgApi.reporting).mockResolvedValue(report);
  vi.mocked(orgApi.domains).mockResolvedValue([]);
  vi.mocked(orgApi.listMembers).mockResolvedValue([]);
  vi.mocked(orgApi.viewers).mockResolvedValue([]);
  fixture.signOut.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('account and scoped reporting', () => {
  it('keeps identity and initials visible while profile and avatar are pending or fail', async () => {
    let resolve!: (p: Profile) => void;
    vi.mocked(orgApi.profile).mockReturnValue(new Promise((done) => { resolve = done; }));
    const { container } = mount(<AccountFooter />);
    expect(screen.getByText('Fixture Member')).toBeVisible();
    expect(screen.getByText('org-a')).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('Loading workspace profile');
    const image = container.querySelector('img');
    if (!image) throw new Error('Avatar image missing');
    expect(image).toHaveStyle({ opacity: '0' });
    expect(container.querySelector('.cb-avatar')).toHaveTextContent('FM');
    fireEvent.error(image);
    expect(image).toHaveStyle({ opacity: '0' });
    await act(async () => resolve(profile));
    expect(await screen.findByText('Role: viewer')).toBeVisible();
  });

  it.each([401, 403, 503])('separates profile failure %s and supports retry', async (status) => {
    vi.mocked(orgApi.profile).mockRejectedValueOnce({ response: { status } });
    mount(<AccountFooter />);
    expect(await screen.findByRole('alert')).toHaveTextContent(status === 503 ? 'Check your connection' : 'authorization failed');
    expect(screen.getByText('Role: unavailable')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry access' }));
    expect(await screen.findByText('Role: viewer')).toBeVisible();
  });

  it('offers account actions and shows sign-out failure', async () => {
    fixture.signOut.mockRejectedValue(new Error('offline'));
    const { container } = mount(<AccountFooter />);
    await screen.findByText('Role: viewer');
    const summary = container.querySelector('summary');
    if (!summary) throw new Error('Account menu missing');
    fireEvent.click(summary);
    fireEvent.click(screen.getByRole('button', { name: 'Manage account' }));
    expect(fixture.openUserProfile).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Workspace settings' })).toHaveAttribute('href', '/settings');
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Sign out failed');
  });

  it('fails closed if a cached administrator profile fails revalidation', async () => {
    function Probe() { const c = useOrgContext(); return <p>{c.isAdmin ? 'allowed' : 'denied'}</p>; }
    vi.mocked(orgApi.profile).mockResolvedValueOnce({ ...profile, permissions: ['org.members.manage'] });
    const { client } = mount(<Probe />);
    await screen.findByText('allowed');
    vi.mocked(orgApi.profile).mockRejectedValue({ response: { status: 403 } });
    await act(async () => { await client.invalidateQueries({ queryKey: ['org-profile'] }); });
    expect(await screen.findByText('denied')).toBeVisible();
  });

  it('uses server scope, not admin-like Clerk role, and separates share and send counts', async () => {
    mount(<><ReportingSummary /><OrganizationSettings /></>);
    await screen.findByText(/Email sends: not measured/);
    expect(screen.getByText('4')).toBeVisible();
    expect(screen.getByText(/Read-only reporting\. Creating shares/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Grant read-only reporting' })).not.toBeInTheDocument();
    expect(orgApi.listMembers).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Team leader ID'), { target: { value: 'leader-id' } });
    fireEvent.change(screen.getByLabelText('Member ID'), { target: { value: 'member-id' } });
    fireEvent.change(screen.getByLabelText('Share type'), { target: { value: 'page' } });
    fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '2026-10-01' } });
    fireEvent.change(screen.getByLabelText('Through (UTC)'), { target: { value: '2026-10-24' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(orgApi.reporting).toHaveBeenLastCalledWith({ team: 'leader-id', user: 'member-id', kind: 'page', from: '2026-10-01T00:00:00.000Z', to: '2026-10-24T23:59:59.999Z' }));
    vi.mocked(orgApi.reporting).mockRejectedValue({ response: { status: 403 } });
    fireEvent.change(screen.getByLabelText('Team leader ID'), { target: { value: 'outside' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('outside your granted scope');
    expect(screen.queryByText('4')).not.toBeInTheDocument();
  });

  it('rejects a reversed date range before requesting a report', async () => {
    mount(<ReportingSummary />); await screen.findByText(/Email sends: not measured/);
    fireEvent.change(screen.getByLabelText('From (UTC)'), { target: { value: '2026-10-24' } });
    fireEvent.change(screen.getByLabelText('Through (UTC)'), { target: { value: '2026-10-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(screen.getByRole('alert')).toHaveTextContent('start date must be on or before');
    expect(orgApi.reporting).toHaveBeenCalledTimes(1);
  });

  it('keeps members in their own view and leads in server-scoped team view', async () => {
    vi.mocked(orgApi.profile).mockResolvedValueOnce({ ...profile, permissions: ['share.create'], report_scope: 'own' });
    const { client } = mount(<ReportingSummary />);
    await screen.findByText(/Scope: own/);
    expect(screen.getByLabelText('Member ID')).toBeDisabled();
    expect(screen.getByLabelText('Team leader ID')).toBeDisabled();
    vi.mocked(orgApi.profile).mockResolvedValue({ ...profile, permissions: ['share.create', 'team.manage'], report_scope: 'team' });
    await act(async () => { await client.invalidateQueries({ queryKey: ['org-profile'] }); });
    expect(await screen.findByText(/Scope: team/)).toBeVisible();
    expect(screen.getByLabelText('Member ID')).toBeEnabled();
  });

  it('exposes IT domains, members, teams and grants only with server permissions', async () => {
    vi.mocked(orgApi.profile).mockResolvedValue({ ...profile, role: 'custom', permissions: ['org.domains.manage', 'org.members.manage', 'org.viewers.grant'] });
    mount(<OrganizationSettings />);
    await screen.findByRole('heading', { name: 'Organization domains' });
    expect(screen.getByRole('heading', { name: 'Members and teams' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save team assignment' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Grant read-only reporting' })).toBeInTheDocument();
  });

  it('isolates cached and late responses and discards drafts on org switching', async () => {
    let finishOld!: (value: string) => void;
    const fetchData = vi.fn().mockReturnValueOnce(new Promise<string>((resolve) => { finishOld = resolve; })).mockResolvedValue('Org B only');
    function Probe() { const q = useQuery({ queryKey: ['same-key'], queryFn: fetchData }); return <><p>{q.data ?? 'Pending'}</p><input aria-label="Draft" defaultValue="" /></>; }
    const { rerender } = render(<SessionScope><Probe /></SessionScope>);
    await screen.findByLabelText('Draft');
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'Org A private draft' } });
    fixture.orgId = 'org-b';
    rerender(<SessionScope><Probe /></SessionScope>);
    expect(await screen.findByText('Org B only')).toBeVisible();
    expect(screen.getByLabelText('Draft')).toHaveValue('');
    await act(async () => finishOld('Org A private data'));
    expect(screen.queryByText('Org A private data')).not.toBeInTheDocument();
    expect(screen.getByText('Org B only')).toBeVisible();
  });
});
