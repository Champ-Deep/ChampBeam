import { describe, expect, it, vi } from 'vitest';
import api from './client';
import { pagesApi } from './pages';

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
