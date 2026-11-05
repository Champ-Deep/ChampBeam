import { describe, expect, it, vi } from 'vitest';
import api from './client';
import { ensureGated, pagesApi } from './pages';

vi.mock('./client', () => ({ default: { get: vi.fn() } }));

// Real Worker shape (observed on wrangler dev): url is the legacy /p/ address, public_url the root slug.
const row = { page_id: 'p1', url: 'https://share.invalid/p/brief', public_url: 'https://share.invalid/brief', legacy_url: 'https://share.invalid/f/abc' };

describe('pagesApi canonical address', () => {
  it('lists and gets pages with the root-slug public_url as url', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [row] }).mockResolvedValueOnce({ data: row });
    expect((await pagesApi.list())[0].url).toBe('https://share.invalid/brief');
    expect((await pagesApi.get('p1')).url).toBe('https://share.invalid/brief');
  });

  it('keeps url when the server sends no public_url', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ data: [{ ...row, public_url: undefined }] });
    expect((await pagesApi.list())[0].url).toBe('https://share.invalid/p/brief');
  });
});

describe('ensureGated', () => {
  const page = { page_id: 'p1', has_access_code: false };
  it('does nothing without a code or when the server already gated it', async () => {
    const patch = vi.fn();
    expect(await ensureGated(page, '', patch)).toBe(true);
    expect(await ensureGated({ ...page, has_access_code: true }, '123456', patch)).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });
  it('patches the code when create dropped it', async () => {
    const patch = vi.fn().mockResolvedValue({});
    expect(await ensureGated(page, '123456', patch)).toBe(true);
    expect(patch).toHaveBeenCalledWith('p1', { access_code: '123456' });
  });
  it('takes the page offline when the code cannot be set', async () => {
    const patch = vi.fn().mockRejectedValueOnce(new Error('400')).mockResolvedValueOnce({});
    expect(await ensureGated(page, '123456', patch)).toBe(false);
    expect(patch).toHaveBeenLastCalledWith('p1', { enabled: false });
  });
});
