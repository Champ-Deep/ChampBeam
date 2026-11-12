import { act, fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage, DomainRow } from './SettingsPage';
import { ConfirmProvider } from '../components/ui/ConfirmDialog';
import { utmApi } from '../api/utm';
import { systemApi } from '../api/system';
import type { Domain } from '../api/utm';

vi.mock('@clerk/react', () => ({ useAuth: () => ({ userId: 'test-user' }) }));
vi.mock('../hooks/useOrgContext', () => ({ useOrgContext: () => ({ inOrg: false, orgId: null, permissions: [], isLoading: false, error: null }) }));
const domain: Domain = {
  id: 'test-domain', hostname: 'share.lakeb2b.com', status: 'pending_cname', ssl_status: 'pending_validation',
  verification_errors: null, is_primary: false, created_at: '', verified_at: null, last_checked_at: null,
  cname_target: null, cloudflare_managed: true, procured: false, registrar: null, registration_status: null,
  auto_renew: false, registration_price: null, domain_expires_at: null,
  dns_records: [
    { type: 'CNAME', name: 'share.lakeb2b.com', value: 'cname.fixture.invalid', purpose: 'Routes traffic' },
    { type: 'TXT', name: '_cf-custom-hostname.share.lakeb2b.com', value: 'ownership-exact-value', purpose: 'Proves ownership' },
    { type: 'TXT', name: '_acme-challenge.share.lakeb2b.com', value: 'certificate-exact-value', purpose: 'Validates certificate' },
  ],
};
const writeText = vi.fn();
function mount(children: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return { client, ...render(<QueryClientProvider client={client}><MemoryRouter><ConfirmProvider>{children}</ConfirmProvider></MemoryRouter></QueryClientProvider>) };
}
function row() { return mount(<DomainRow domain={domain} config={undefined} onRefresh={vi.fn()} onSetPrimary={vi.fn()} onDelete={vi.fn()} refreshing={false} />); }
beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  writeText.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('Domain DNS handoff', () => {
  it('copies each exact name and value from all three API records, even without a separate cname_target', async () => {
    row();
    const valueButtons = [screen.getByRole('button', { name: 'Copy CNAME value' }), ...screen.getAllByRole('button', { name: 'Copy TXT value' })];
    for (const [index, button] of valueButtons.entries()) {
      fireEvent.click(button);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(domain.dns_records?.[index].value));
      await waitFor(() => expect(button).toHaveTextContent('Copied'));
    }
    const nameButtons = [screen.getByRole('button', { name: 'Copy CNAME name' }), ...screen.getAllByRole('button', { name: 'Copy TXT name' })];
    for (const [index, button] of nameButtons.entries()) {
      fireEvent.click(button);
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(domain.dns_records?.[index].name));
    }
  });
  it('copies the server records.txt body unchanged, rather than reconstructing it', async () => {
    const text = 'Server IT request\n  Exact whitespace and all records.\n';
    vi.spyOn(utmApi, 'domainRecordsText').mockResolvedValue(text);
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Copy all for IT' }));
    await screen.findByText('Copied all records for IT.');
    expect(utmApi.domainRecordsText).toHaveBeenCalledWith(domain.id);
    expect(writeText).toHaveBeenCalledWith(text);
  });
  it('does not claim success when clipboard permission is denied, and can retry', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    row();
    const button = screen.getByRole('button', { name: 'Copy CNAME value' });
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Retry copy'));
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Copied'));
  });
  it('surfaces a failed IT request and clears the notice after retry', async () => {
    vi.spyOn(utmApi, 'domainRecordsText').mockRejectedValueOnce(new Error('offline')).mockResolvedValue('retry body');
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Copy all for IT' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Copy all for IT' }));
    await screen.findByText('Copied all records for IT.');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('downloads the same text via an object URL and releases it', async () => {
    const text = 'download exact text\n';
    vi.spyOn(utmApi, 'domainRecordsText').mockResolvedValue(text);
    const blobUrl = vi.fn(() => 'blob:dns');
    const release = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: blobUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: release });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('share.lakeb2b.com-dns-records.txt');
      expect(this.href).toBe('blob:dns');
    });
    row();
    fireEvent.click(screen.getByRole('button', { name: 'Download .txt' }));
    await screen.findByText('DNS records downloaded.');
    expect(blobUrl.mock.calls).toHaveLength(1);
    expect(click).toHaveBeenCalledOnce();
    await waitFor(() => expect(release).toHaveBeenCalledWith('blob:dns'));
  });
  it('rechecks pending DNS every 20 seconds and stops once active, without reloading', async () => {
    vi.useFakeTimers();
    vi.spyOn(systemApi, 'access').mockResolvedValue({ is_admin: false });
    vi.spyOn(utmApi, 'getDomainsConfig').mockResolvedValue({ subdomain_enabled: false, platform_subdomain_base: null, byod_enabled: true, cname_target: null, procurement_enabled: false });
    const list = vi.spyOn(utmApi, 'listDomains').mockResolvedValue([domain]);
    const refresh = vi.spyOn(utmApi, 'refreshDomain').mockResolvedValueOnce(domain).mockResolvedValue({ ...domain, status: 'active', ssl_status: 'active' });
    const { client } = mount(<SettingsPage />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByText('Waiting on CNAME')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(screen.getByText('Active')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(list).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(2);
    client.clear();
  });

  it('still renders the records and copy buttons when the status refresh fails', async () => {
    vi.spyOn(systemApi, 'access').mockResolvedValue({ is_admin: false });
    vi.spyOn(utmApi, 'getDomainsConfig').mockResolvedValue({ subdomain_enabled: false, platform_subdomain_base: null, byod_enabled: true, cname_target: null, procurement_enabled: false });
    vi.spyOn(utmApi, 'listDomains').mockResolvedValue([domain]);
    vi.spyOn(utmApi, 'refreshDomain').mockRejectedValue(new Error('502'));
    const { client } = mount(<SettingsPage />);
    expect((await screen.findAllByText('share.lakeb2b.com')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('button', { name: /^Copy (CNAME|TXT) (value|name)/ }).length).toBeGreaterThanOrEqual(3);
    client.clear();
  });
});
