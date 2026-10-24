import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { ShareComposer } from './ShareComposer';
import { useOrgContext } from '../hooks/useOrgContext';
import { filesApi, type FileAsset } from '../api/files';
import { pagesApi } from '../api/pages';
import { orgApi } from '../api/org';
import { isDownload } from '../hooks/useShareLists';

vi.mock('@clerk/react', () => ({ useAuth: () => ({ isSignedIn: true, userId: 'fixture-user', orgId: 'fixture-org', orgRole: 'org:superadmin' }) }));
vi.mock('../api/org', () => ({ orgApi: { profile: vi.fn() } }));
vi.mock('../api/files', () => ({ filesApi: { initUpload: vi.fn(), uploadBytes: vi.fn(), finalize: vi.fn() } }));
vi.mock('../api/pages', () => ({ pagesApi: { suggestSlug: vi.fn(), create: vi.fn() } }));
const profile = { user_id: 'fixture-user', full_name: 'Fixture User', email: null, org: { id: 'fixture-org', name: 'Fixture workspace', slug: 'fixture' }, role: 'member', permissions: ['share.create'], report_scope: 'own' as const, share_host: { default: 'fixture.example', default_domain_id: null }, available_hosts: [] };
function mount(ui = <ShareComposer />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>);
}
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  vi.clearAllMocks();
  vi.mocked(orgApi.profile).mockResolvedValue(profile);
  vi.mocked(pagesApi.suggestSlug).mockResolvedValue({ slug: 'quarterly-brief', base: 'quarterly-brief', collided: false, host: 'fixture.example', public_url: 'https://fixture.example/quarterly-brief' });
  vi.mocked(filesApi.initUpload).mockResolvedValue({ file_id: 'fixture-file', short_code: 'fixture', presigned_put_url: '/fixture-upload', headers: {}, serve_mode: 'stream' });
  vi.mocked(filesApi.uploadBytes).mockResolvedValue();
  vi.mocked(filesApi.finalize).mockResolvedValue({ id: 'fixture-file', output_kind: 'file', public_url: 'https://fixture.example/f/fixture' } as FileAsset);
});
afterEach(cleanup);

describe('one composer', () => {
  it('does not upload on file selection and requires intent', async () => {
    mount(); await screen.findByLabelText('Choose file');
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'Quarterly Brief.pdf', { type: 'application/pdf' })] } });
    expect(filesApi.initUpload).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('tab', { name: 'Send as file' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create download link' }));
    await screen.findByText('Download ready');
    expect(filesApi.initUpload).toHaveBeenCalledWith(expect.objectContaining({ intent: 'download', filename: 'Quarterly Brief.pdf', slug: undefined }));
  });
  it.each(['application/pdf', 'image/png', 'video/mp4'])('hosts %s with an editable basename slug', async (type) => {
    mount(); await screen.findByLabelText('Choose file');
    fireEvent.change(screen.getByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'Quarterly Brief.pdf', { type })] } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Host for viewing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit address' }));
    await waitFor(() => expect(screen.getByLabelText(/^Page address/)).toHaveValue('quarterly-brief'));
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: 'custom-page' } });
    fireEvent.click(screen.getByRole('button', { name: 'Publish page' }));
    await waitFor(() => expect(filesApi.initUpload).toHaveBeenCalledWith(expect.objectContaining({ intent: 'host', slug: 'custom-page' })));
  });
  it('keeps input after a collision and shows the API error', async () => {
    vi.mocked(pagesApi.create).mockRejectedValue({ response: { status: 409, data: { detail: 'That slug is taken.' } } });
    mount(); await screen.findByLabelText('Paste content or drop one file');
    fireEvent.change(screen.getByLabelText('Paste content or drop one file'), { target: { value: '<!doctype html><html>Fixture</html>' } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Host for viewing' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish page' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish page' }));
    await screen.findByText('That slug is taken.');
    expect(screen.getByLabelText('Paste content or drop one file')).toHaveValue('<!doctype html><html>Fixture</html>');
  });
  it('routes external URLs to Links rather than inventing URL import', async () => {
    mount(); await screen.findByLabelText('Paste content or drop one file');
    fireEvent.change(screen.getByLabelText('Paste content or drop one file'), { target: { value: 'https://example.com/path' } });
    expect(screen.getByRole('link', { name: 'Track external URL' })).toHaveAttribute('href', '/links?tab=utm&url=https%3A%2F%2Fexample.com%2Fpath');
    expect(filesApi.initUpload).not.toHaveBeenCalled();
  });
  it('delegates Unicode and multi-extension basenames to the backend and accepts collision suggestions', async () => {
    vi.mocked(pagesApi.suggestSlug).mockResolvedValue({ slug: 'cafe-final-2', base: 'cafe-final', collided: true, host: 'fixture.example', public_url: 'https://fixture.example/cafe-final-2' });
    mount();
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'Café.final.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Host for viewing' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Use suggested address' }));
    expect(pagesApi.suggestSlug).toHaveBeenCalledWith('Café.final.pdf', undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Edit address' }));
    expect(screen.getByLabelText('Page address')).toHaveValue('cafe-final-2');
  });
  it('does not silently fall back when the selected domain is missing', async () => {
    vi.mocked(orgApi.profile).mockResolvedValue({ ...profile, share_host: { default: 'fixture.example', default_domain_id: 'removed-domain' } });
    mount();
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'file.pdf', { type: 'application/pdf' })] } });
    expect(screen.getByRole('alert')).toHaveTextContent('domain is unavailable or invalid');
    expect(screen.getByRole('button', { name: 'Create download link' })).toBeDisabled();
  });
  it('preserves the draft on invalid file input and supports removal', async () => {
    mount(); const input = await screen.findByLabelText('Choose file');
    fireEvent.change(input, { target: { files: [new File(['fixture'], 'keep.zip', { type: 'application/zip' })] } });
    const huge = new File(['fixture'], 'large.png', { type: 'image/png' });
    Object.defineProperty(huge, 'size', { value: 11 * 1024 * 1024 });
    fireEvent.change(input, { target: { files: [huge] } });
    expect(screen.getByRole('alert')).toHaveTextContent('10 MB limit');
    expect(screen.getByText('keep.zip')).toBeVisible();
    expect(screen.queryByRole('tab', { name: 'Host for viewing' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
    expect(screen.getByLabelText('Paste content or drop one file')).toHaveValue('');
    expect(screen.queryByText('keep.zip')).toBeNull();
  });
  it('handles file paste, page-wide URL paste and multiline typing without submitting', async () => {
    mount(); const text = await screen.findByLabelText('Paste content or drop one file');
    fireEvent.paste(text, { clipboardData: { files: [new File(['fixture'], 'paste.pdf', { type: 'application/pdf' })] } });
    expect(screen.getByText('paste.pdf')).toBeVisible();
    fireEvent.paste(document.body, { clipboardData: { files: [], getData: () => 'https://example.com/pasted' } });
    expect(screen.getByLabelText('Paste content or drop one file')).toHaveValue('https://example.com/pasted');
    fireEvent.keyDown(screen.getByLabelText('Paste content or drop one file'), { key: 'Enter' });
    expect(screen.getByLabelText('Paste content or drop one file')).toHaveValue('https://example.com/pasted');
    expect(filesApi.initUpload).not.toHaveBeenCalled();
  });
  it('retries a failed slug check without changing input', async () => {
    vi.mocked(pagesApi.suggestSlug).mockRejectedValueOnce(new Error('Offline'));
    mount();
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'file.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Host for viewing' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry address check' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish page' })).toBeEnabled());
    expect(screen.getByText('file.pdf')).toBeVisible();
  });
  it('retains a Unicode edited slug after server validation failure', async () => {
    vi.mocked(filesApi.initUpload).mockRejectedValueOnce({ response: { status: 400, data: { detail: 'Slug must be 3\u201360 characters of lowercase letters, numbers and hyphens.' } } });
    mount();
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'file.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(await screen.findByRole('tab', { name: 'Host for viewing' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit address' }));
    fireEvent.change(screen.getByLabelText('Page address'), { target: { value: '日本語' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish page' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Publish page' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('3-60 characters');
    expect(screen.getByLabelText('Page address')).toHaveValue('日本語');
  });
  it('keeps a successful URL usable after clipboard rejection', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
    mount();
    fireEvent.change(await screen.findByLabelText('Choose file'), { target: { files: [new File(['fixture'], 'file.zip', { type: 'application/zip' })] } });
    fireEvent.click(screen.getByRole('button', { name: 'Create download link' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Copy address' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('copy it manually');
    expect(screen.getByRole('link', { name: 'https://fixture.example/f/fixture' })).toHaveAttribute('href', 'https://fixture.example/f/fixture');
  });
  it('denies create UI based on server permissions despite an admin-like Clerk role', async () => {
    vi.mocked(orgApi.profile).mockResolvedValue({ ...profile, role: 'viewer', permissions: [], report_scope: 'org' });
    mount(); await screen.findByText('Read-only workspace');
    expect(screen.queryByLabelText('Choose file')).not.toBeInTheDocument();
  });
  it('does not offer a reporting link to a viewer with no reporting scope', async () => {
    vi.mocked(orgApi.profile).mockResolvedValue({ ...profile, role: 'viewer', permissions: [], report_scope: 'none' });
    mount(); await screen.findByText('Read-only workspace');
    expect(screen.queryByRole('link', { name: 'Open reporting' })).not.toBeInTheDocument();
    expect(screen.getByText(/cannot create shares or open reporting/)).toBeInTheDocument();
  });
  it('does not infer admin rights from role text', async () => {
    function Probe() { const context = useOrgContext(); return <p>{context.isAdmin ? 'admin granted' : 'admin denied'}</p>; }
    mount(<Probe />); await screen.findByText('admin denied');
    expect(screen.queryByText('admin granted')).not.toBeInTheDocument();
  });
  it('separates explicit downloads, hosted media and legacy HTML', () => {
    expect(isDownload({ kind: 'html', output_kind: 'file' } as FileAsset)).toBe(false);
    expect(isDownload({ kind: 'html', intent: 'download', output_kind: 'file' } as FileAsset)).toBe(true);
    expect(isDownload({ kind: 'pdf', intent: 'host', output_kind: 'page' } as FileAsset)).toBe(false);
    expect(isDownload({ kind: 'pdf', output_kind: 'file' } as FileAsset)).toBe(true);
  });
});
