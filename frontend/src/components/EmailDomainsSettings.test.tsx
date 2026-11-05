import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmailDomainsSettings } from './EmailDomainsSettings';
import { orgApi } from '../api/org';
import { ConfirmProvider } from './ui/ConfirmDialog';

vi.mock('../hooks/useOrgContext', () => ({ useOrgContext: () => ({ orgId: 'org-a' }) }));
vi.mock('../api/org', () => ({ orgApi: { emailDomains: vi.fn(), addEmailDomain: vi.fn(), removeEmailDomain: vi.fn() } }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ConfirmProvider><EmailDomainsSettings /></ConfirmProvider></QueryClientProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(orgApi.emailDomains).mockResolvedValue([{ domain: 'lakeb2b.com', created_at: '2026-11-06T00:00:00Z' }]);
});
afterEach(cleanup);

describe('Company email domains', () => {
  it('lists domains with the Auto-join badge', async () => {
    mount();
    expect(await screen.findByText('lakeb2b.com')).toBeVisible();
    expect(screen.getByText('Auto-join')).toBeVisible();
  });

  it('adds a domain, refetching the list', async () => {
    vi.mocked(orgApi.addEmailDomain).mockResolvedValue({ domain: 'acme.com', created_at: '' });
    mount();
    await screen.findByText('lakeb2b.com');
    fireEvent.change(screen.getByLabelText('Email domain'), { target: { value: ' acme.com ' } });
    fireEvent.click(screen.getByRole('button', { name: /Add domain/ }));
    await waitFor(() => expect(orgApi.addEmailDomain).toHaveBeenCalledWith('acme.com'));
    await waitFor(() => expect(orgApi.emailDomains).toHaveBeenCalledTimes(2));
  });

  it('removes a domain only after confirmation', async () => {
    vi.mocked(orgApi.removeEmailDomain).mockResolvedValue();
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove lakeb2b.com' }));
    expect(orgApi.removeEmailDomain).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(orgApi.removeEmailDomain).toHaveBeenCalledWith('lakeb2b.com'));
  });
});
