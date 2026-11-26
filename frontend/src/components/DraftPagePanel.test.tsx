import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DraftPagePanel } from './DraftPagePanel';
import { ConfirmProvider } from './ui/ConfirmDialog';
import { assistantApi } from '../api/assistant';

vi.mock('../api/assistant', () => ({ assistantApi: { generatePage: vi.fn() } }));
const generate = vi.mocked(assistantApi.generatePage);
const brief = 'Help the sales team reach buyers.';
const input = { company: 'Acme', brief, brand: 'champions-group' };
const draft = { html: '<h1>Draft</h1>', model: 'fixture', usage: {prompt_tokens: 1, completion_tokens: 1}, checks: {figures_ok: true as const, bytes: 14}, content: {headline: 'Draft', subhead: '', pains: [], proof: [], how_we_help: [], cta_label: ''} };
const published = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('matchMedia', () => ({matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}}));
  render(<ConfirmProvider><DraftPagePanel onCopy={vi.fn()} onPublished={published} /></ConfirmProvider>);
  fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Acme' } });
  fireEvent.change(screen.getByLabelText('Brief'), { target: { value: brief } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function preview() {
  generate.mockResolvedValueOnce(draft);
  fireEvent.click(screen.getByText('Preview'));
  return screen.findByTitle('One-pager preview');
}
it('previews only in an empty sandbox and invalidates the preview on edit', async () => {
  const frame = await preview();
  expect(generate).toHaveBeenCalledWith({...input, dry_run: true});
  expect(frame).toHaveAttribute('sandbox', '');
  expect(frame).toHaveAttribute('srcdoc', draft.html);
  fireEvent.change(screen.getByLabelText('Company'), {target: {value: 'New company'}});
  expect(screen.queryByText('Publish')).not.toBeInTheDocument();
});
it('sends nothing on cancel and publishes only the confirmed inputs', async () => {
  await preview();
  fireEvent.click(screen.getByText('Publish'));
  fireEvent.click(screen.getByText('Cancel'));
  expect(generate).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByText('Publish'));
  generate.mockResolvedValueOnce({ model: 'fixture', usage: draft.usage, url: 'https://example.test/p/acme', page: { page_id: 'acme', short_code: 'acme', slug: null, url: 'https://example.test/p/acme', legacy_url: '', title: 'Acme', size_bytes: 14, view_count: 0, unique_visitors: 0, revisits: 0, total_dwell_ms: 0, enabled: true, has_access_code: false, domain_id: null, created_at: '', updated_at: '', current_version: 1 } });
  fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Publish'));
  expect(await screen.findByText('One-pager published')).toBeInTheDocument();
  expect(generate).toHaveBeenLastCalledWith({...input, dry_run: false});
  expect(published).toHaveBeenCalledTimes(1);
});
it.each([[422, 'The draft contained figures not in the brief: 40%.'], [503, 'Assistant off'], [429, 'Daily cap reached']])('keeps the brief on %s', async (status, detail) => {
  generate.mockRejectedValueOnce({response: {status, data: {detail}}});
  fireEvent.click(screen.getByText('Preview'));
  expect(await screen.findByRole('alert')).toHaveTextContent(String(detail));
  expect(screen.getByLabelText('Brief')).toHaveValue(brief);
});
