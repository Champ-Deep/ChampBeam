import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../ui/ConfirmDialog';
import { InviteSheet } from './InviteSheet';
import { MembersPanel } from './MembersPanel';
import { DnsRecordsCard } from './DnsRecords';
import { OrgSwitcher } from '../OrgSwitcher';
import { OnboardingChecklist } from './OnboardingChecklist';
import { CreateOrgEntry } from '../../pages/SettingsPage';
import { dnsRecordsFor, nextPath, recordsForIt, refusal } from '../../lib/selfServeRules';
import type { AppConfig } from '../../api/selfServe';

const fx = vi.hoisted(() => ({
  config: { email_enabled: false, custom_domains_enabled: false, is_super_admin: false, can_create_org: false, platform_host: 'champbeam.test' } as AppConfig,
  invite: vi.fn(), pending: vi.fn(), listMembers: vi.fn(), updateMemberRole: vi.fn(), removeMember: vi.fn(),
}));
vi.mock('../../hooks/useAppConfig', () => ({ useAppConfig: () => ({ data: fx.config, isLoading: false }) }));
vi.mock('../../api/selfServe', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  selfServeApi: { invite: fx.invite, pendingInvitations: fx.pending, adminOrgs: vi.fn(async () => []) },
}));
vi.mock('../../api/org', () => ({ orgApi: { listMembers: vi.fn(async () => []), getContext: vi.fn(async () => ({ member_count: 1 })) } }));
vi.mock('../../hooks/useOrgContext', () => ({ useOrgContext: () => ({ inOrg: false, isAdmin: false, permissions: [], isLoading: false, error: null }) }));
vi.mock('../../hooks/useShareLists', () => ({ useShareLists: () => ({ files: { data: [] }, pages: { data: [] }, links: { data: [] } }) }));
vi.mock('../../lib/authClient', () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: 'u-me', orgId: 'org-1', user: { id: 'u-me', email: 'me@acme.test' } }),
  authClient: {
    useListOrganizations: () => ({ data: [{ id: 'org-1', name: 'Acme' }], isPending: false, error: null }),
    organization: {
      listMembers: fx.listMembers, updateMemberRole: fx.updateMemberRole, removeMember: fx.removeMember,
      getActiveMemberRole: vi.fn(async () => ({ data: { role: 'admin' }, error: null })), setActive: vi.fn(), cancelInvitation: vi.fn(),
    },
  },
}));

function mount(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><ConfirmProvider>{ui}</ConfirmProvider></MemoryRouter></QueryClientProvider>);
}
const writeText = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  fx.config = { ...fx.config, email_enabled: false, is_super_admin: false, can_create_org: false };
  fx.pending.mockResolvedValue([]);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});

describe('invite sheet', () => {
  it('returns a copyable accept link when email is off', async () => {
    fx.invite.mockResolvedValue({ id: 'inv-1', email: 'priya@acme.test', role: 'member', accept_url: 'https://champbeam.test/accept-invitation/inv-1', email_sent: false });
    mount(<InviteSheet open onOpenChange={() => {}} orgName="Acme" emailEnabled={false} />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'Priya@Acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create invite link' }));
    const link = 'https://champbeam.test/accept-invitation/inv-1?email=priya%40acme.test';
    expect(await screen.findByText(link)).toBeVisible();
    expect(fx.invite).toHaveBeenCalledWith('priya@acme.test', 'member');
    expect(screen.queryByText(/Invitation sent/)).toBeNull();
    const results = screen.getByRole('heading', { name: 'Links to send' }).closest('section') as HTMLElement;
    fireEvent.click(within(results).getByRole('button', { name: /Copy link/ }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(link));
  });

  it('says the invitation was sent when email is on, without a link list', async () => {
    fx.invite.mockResolvedValue({ id: 'inv-2', email: 'sam@acme.test', role: 'admin', accept_url: 'https://champbeam.test/accept-invitation/inv-2', email_sent: true });
    mount(<InviteSheet open onOpenChange={() => {}} orgName="Acme" emailEnabled />);
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'sam@acme.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send invitations' }));
    expect(await screen.findByText('Invitation sent to sam@acme.test.')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'Links to send' })).toBeNull();
  });
});

describe('members', () => {
  it('states the last-admin refusal inline and does not call the server', async () => {
    fx.listMembers.mockResolvedValue({ data: { members: [
      { id: 'm-me', userId: 'u-me', role: 'admin', createdAt: '2026-03-01T00:00:00Z', user: { name: 'Deep S', email: 'me@acme.test', image: null } },
      { id: 'm-2', userId: 'u-2', role: 'member', createdAt: '2026-04-01T00:00:00Z', user: { name: 'Priya K', email: 'priya@acme.test', image: null } },
    ], total: 2 }, error: null });
    mount(<MembersPanel orgId="org-1" orgName="Acme" />);
    fireEvent.change(await screen.findByLabelText('Role for Deep S'), { target: { value: 'member' } });
    expect(await screen.findByRole('alert')).toHaveTextContent('The last admin cannot be removed or demoted. Make someone else an admin first.');
    expect(fx.updateMemberRole).not.toHaveBeenCalled();
  });

  it('refuses self-removal and allows a second admin to be demoted', () => {
    const me = { memberId: 'm', userId: 'u-me', name: 'Me', email: '', image: null, role: 'admin', joinedAt: null };
    expect(refusal(me, 'remove', { me: 'u-me', adminCount: 2 })).toMatch(/cannot remove yourself/);
    expect(refusal(me, 'role', { me: 'u-me', adminCount: 2, nextRole: 'member' })).toBeNull();
    expect(nextPath(new URLSearchParams('next=//evil.test'))).toBe('/');
    expect(nextPath(new URLSearchParams('next=/accept-invitation/x'))).toBe('/accept-invitation/x');
  });
});

describe('domain DNS card', () => {
  it('copies the exact record values, one by one and all for IT', async () => {
    const records = dnsRecordsFor('share.acme.com', 'cname.champbeam.com');
    const { container } = mount(<DnsRecordsCard hostname="share.acme.com" records={records} />);
    // Break points sit only after "." or "-", and the rendered text stays exact.
    const values = [...container.querySelectorAll('.cb-dns-value')];
    expect(values.map((v) => v.textContent)).toEqual(['share.acme.com', 'cname.champbeam.com']);
    expect(values[1].querySelectorAll('wbr')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Copy CNAME value' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('cname.champbeam.com'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy CNAME name' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('share.acme.com'));
    fireEvent.click(screen.getByRole('button', { name: /Copy all for IT/ }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(recordsForIt('share.acme.com', records)));
    expect(recordsForIt('share.acme.com', records)).toBe('DNS records for share.acme.com\n\nType: CNAME\nName: share.acme.com\nValue: cname.champbeam.com');
  });
});

describe('org switcher', () => {
  async function openMenu() {
    mount(<OrgSwitcher />);
    fireEvent.keyDown(screen.getByRole('button', { name: /Switch workspace/ }), { key: 'Enter' });
    await screen.findAllByRole('menuitem');
  }
  it('hides the super-admin and create entries for a normal user', async () => {
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: /All organizations/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Create organization/ })).toBeNull();
  });
  it('shows them to the super admin, with role badges', async () => {
    fx.config = { ...fx.config, is_super_admin: true, can_create_org: true };
    await openMenu();
    expect(screen.getByRole('menuitem', { name: /All organizations/ })).toHaveAttribute('href', '/admin/orgs');
    expect(screen.getByRole('menuitem', { name: /Create organization/ })).toBeVisible();
    expect(await screen.findAllByText('Admin')).not.toHaveLength(0);
  });
});

describe('create organization entry points', () => {
  it('a user without can_create_org sees no create entry in the switcher, Settings or the checklist', async () => {
    mount(<><OrgSwitcher /><CreateOrgEntry /><OnboardingChecklist /></>);
    expect(await screen.findByText('Share your first link')).toBeVisible();
    expect(screen.queryByText('Create an organization')).toBeNull();
    expect(screen.queryByRole('button', { name: /Create organization/ })).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: /Switch workspace/ }), { key: 'Enter' });
    await screen.findAllByRole('menuitem');
    expect(screen.queryByRole('menuitem', { name: /Create organization/ })).toBeNull();
  });
  it('shows the Settings button and the checklist step when can_create_org is on', async () => {
    fx.config = { ...fx.config, can_create_org: true };
    mount(<><CreateOrgEntry /><OnboardingChecklist /></>);
    expect(await screen.findByText('Create an organization')).toBeVisible();
    expect(screen.getAllByRole('button', { name: /Create organization/ }).length).toBeGreaterThan(0); // the checklist hides its button once an org exists
  });
});
