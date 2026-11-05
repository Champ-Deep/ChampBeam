import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from '../components/ui';
import { filesApi, type FileAsset } from '../api/files';
import { pagesApi, type BeamPage } from '../api/pages';
import { utmApi, type UTMPreset } from '../api/utm';
import { isDownload, linkListOptions } from '../hooks/useShareLists';
import { LinksPage } from './LinksPage';
import { PagesPage } from './PagesPage';
import { SettingsPage } from './SettingsPage';
import { PresetsManager } from './PresetsManager';

vi.mock('../hooks/useOrgContext', () => ({ useOrgContext: () => ({ canShare: true, permissions: [], inOrg: false }) }));
vi.mock('../components/ShareComposer', () => ({ ShareComposer: () => <p>Composer test stand-in</p> }));
vi.mock('../api/files', () => ({ filesApi: { list: vi.fn() } }));
vi.mock('../api/pages', () => ({ pagesApi: { list: vi.fn(), availability: vi.fn() } }));
vi.mock('../api/utm', () => ({ utmApi: { getLinkPerformance: vi.fn(), getProjects: vi.fn(), listDomains: vi.fn(), getPresets: vi.fn(), createPreset: vi.fn() } }));

function mount(ui: React.ReactNode, path = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><MemoryRouter initialEntries={[path]}><ConfirmProvider>{ui}</ConfirmProvider></MemoryRouter></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(filesApi.list).mockResolvedValue([]);
  vi.mocked(pagesApi.list).mockResolvedValue([]);
  vi.mocked(utmApi.getProjects).mockResolvedValue([]);
  vi.mocked(utmApi.getLinkPerformance).mockResolvedValue([]);
  vi.mocked(utmApi.listDomains).mockResolvedValue([]);
  vi.mocked(utmApi.getPresets).mockResolvedValue([]);
});
afterEach(cleanup);

describe('share view ownership and states', () => {
  it.each([
    [{ kind: 'html' }, false],
    [{ kind: 'html', intent: 'download' }, true],
    [{ kind: 'pdf', intent: 'host' }, false],
    [{ kind: 'image', output_kind: 'page' }, false],
    [{ kind: 'video', intent: 'download', output_kind: 'file' }, true],
  ])('classifies %j without relabeling hosted assets as downloads', (asset, expected) => {
    expect(isDownload(asset as FileAsset)).toBe(expected);
  });
  it('uses the shared Links query window and does not fall back to all-time project counts', async () => {
    vi.mocked(utmApi.getProjects).mockResolvedValue([{ id: 'fixture-project', name: 'Fixture project', link_count: 3 }] as Awaited<ReturnType<typeof utmApi.getProjects>>);
    mount(<LinksPage />);
    await screen.findByText('No Links Found');
    expect(utmApi.getLinkPerformance).toHaveBeenCalledWith({ days: 365 });
    expect(linkListOptions.queryKey).toEqual(['utm', 'links', 365]);
    expect(screen.queryByText('3', { exact: true })).not.toBeInTheDocument();
  });
  it('shows a retryable Links error instead of an empty list', async () => {
    vi.mocked(utmApi.getLinkPerformance).mockRejectedValue(new Error('fixture outage'));
    mount(<LinksPage />);
    await screen.findByRole('button', { name: 'Retry links' });
    expect(screen.queryByText('No Links Found')).not.toBeInTheDocument();
    vi.mocked(utmApi.getLinkPerformance).mockResolvedValue([]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry links' }));
    await screen.findByText('No Links Found');
  });
  it.each([[401, 'Page access failed'], [403, 'Page access failed'], [503, 'Pages could not load']])('distinguishes Pages status %s', async (status, heading) => {
    vi.mocked(pagesApi.list).mockRejectedValue({ response: { status, data: { detail: 'Fixture error' } } });
    mount(<PagesPage />);
    await screen.findByRole('heading', { name: heading });
    expect(screen.queryByText('No pages yet')).not.toBeInTheDocument();
  });
  it('shows the Pages empty state only for a successful empty response', async () => {
    mount(<PagesPage />);
    await screen.findByText('No pages yet');
  });
  it('does not advertise HTML features or blob liveness for hosted PDF', async () => {
    vi.mocked(pagesApi.list).mockResolvedValue([{ page_id: 'fixture-pdf', title: 'Fixture PDF', kind: 'pdf', enabled: true, current_version: 0, url: 'https://example.invalid/p/fixture', legacy_url: 'https://example.invalid/f/fixture', view_count: 0, size_bytes: 12, updated_at: '2026-10-24T00:00:00Z' }] as BeamPage[]);
    mount(<PagesPage />);
    await screen.findByText('Fixture PDF');
    expect(screen.getByText('PDF', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Enabled', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(/Beam State: on/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Replace' })).not.toBeInTheDocument();
  });
  it.each([401, 403, 404, 503])('checks storage lazily and distinguishes HTTP %s from missing content', async (status) => {
    vi.mocked(pagesApi.list).mockResolvedValue([{ page_id: 'fixture-pdf', title: 'Fixture PDF', kind: 'pdf', enabled: true, url: 'https://example.invalid/p/fixture' }] as BeamPage[]);
    vi.mocked(pagesApi.availability).mockRejectedValue({ response: { status } });
    mount(<PagesPage />);
    await screen.findByText('Fixture PDF');
    expect(pagesApi.availability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Check storage' }));
    await screen.findByText(status === 401 || status === 403 ? 'Storage access failed' : status === 404 ? 'Page record unavailable' : 'Storage check unavailable');
    expect(screen.queryByText('Stored content missing')).not.toBeInTheDocument();
    expect(pagesApi.availability).toHaveBeenCalledTimes(1);
    expect(pagesApi.availability).toHaveBeenCalledWith('fixture-pdf');
    vi.mocked(pagesApi.availability).mockResolvedValue({ status: 'missing' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry storage check' }));
    await screen.findByText('Stored content missing');
    expect(screen.queryByRole('link', { name: 'Open page' })).not.toBeInTheDocument();
    vi.mocked(pagesApi.availability).mockResolvedValue({ status: 'available', size: 12, etag: 'fixture-etag' });
    fireEvent.click(screen.getByRole('button', { name: 'Retry storage check' }));
    expect(await screen.findByRole('link', { name: 'Open page' })).toHaveAttribute('href', 'https://example.invalid/p/fixture');
    vi.mocked(pagesApi.availability).mockRejectedValue({ response: { status: 503 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry storage check' }));
    await screen.findByText('Storage check unavailable');
    expect(screen.queryByText('Stored content available')).not.toBeInTheDocument();
  });
  it.each(['presets', 'utm'])('redirects Settings %s to the Links UTM presets deep link', async (tab) => {
    mount(<Routes><Route path="/settings" element={<SettingsPage />} /><Route path="/links" element={<p>Links destination</p>} /></Routes>, `/settings?tab=${tab}`);
    await screen.findByText('Links destination');
    expect(screen.queryByText('UTM Presets')).not.toBeInTheDocument();
  });
  it('refreshes the shared preset cache after saving', async () => {
    const client = mount(<PresetsManager />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create Preset' }));
    fireEvent.change(screen.getByLabelText('Preset Name'), { target: { value: 'Fixture preset' } });
    const preset = { id: 'fixture-preset', name: 'Fixture preset' } as UTMPreset;
    vi.mocked(utmApi.createPreset).mockResolvedValue(preset);
    vi.mocked(utmApi.getPresets).mockResolvedValue([preset]);
    fireEvent.click(screen.getByRole('button', { name: 'Save Preset' }));
    await waitFor(() => expect(client.getQueryData(['utm', 'presets'])).toEqual([preset]));
    await screen.findByText('Fixture preset');
  });
});
