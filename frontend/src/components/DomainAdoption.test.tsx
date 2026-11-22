import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DomainAdoption } from './DomainAdoption';
import { ConfirmProvider } from './ui/ConfirmDialog';
import { orgApi } from '../api/org';
import type { AdoptionReport } from '../api/org';
const preview: AdoptionReport = { dry_run: true, attached: { links: 2, files: 1 }, adopted: { links: 17, files: 29, aliases: 3 }, collisions: { files: [{ short_code: 'conflict', slug: 'existing-page' }], links: [], aliases: [] } };
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><ConfirmProvider><DomainAdoption domain={{ id: 'domain', hostname: 'share.lakeb2b.com', status: 'active', is_org_default: true }} orgId="org" /></ConfirmProvider></QueryClientProvider>);
}
afterEach(() => vi.restoreAllMocks());
describe('Existing-content prompt', () => {
  it('uses a fresh dry run in confirmation, cancels safely, and surfaces collisions after apply', async () => {
    const call = vi.spyOn(orgApi, 'adoptExisting').mockImplementation(async (_id, dryRun = true) => ({ ...preview, dry_run: dryRun }));
    mount();
    await screen.findByText('17 links, 29 files will move to', { exact: false });
    expect(screen.getByText('existing-page')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Review and move existing content' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('17 links, 29 files will move to share.lakeb2b.com');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(call).not.toHaveBeenCalledWith('domain', false);
    fireEvent.click(screen.getByRole('button', { name: 'Review and move existing content' }));
    await screen.findByRole('alertdialog');
    fireEvent.click(screen.getByRole('button', { name: 'Move existing content' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('domain', false));
    await screen.findByText('17 links, 29 files and 3 aliases moved.');
  });
  it('keeps failed dry runs actionable and recovers on retry', async () => {
    vi.spyOn(orgApi, 'adoptExisting').mockRejectedValueOnce(new Error('offline')).mockResolvedValue(preview);
    mount();
    await screen.findByText('Could not count existing content. Retry before moving anything.');
    fireEvent.click(screen.getByRole('button', { name: 'Review and move existing content' }));
    await screen.findByRole('alertdialog');
    expect(screen.queryByText('Could not count existing content. Retry before moving anything.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  });
});
