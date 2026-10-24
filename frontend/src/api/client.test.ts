import { describe, expect, it } from 'vitest';
import { normalizeApiUrl } from './client';

describe('normalizeApiUrl', () => {
  it('uses the same origin in production builds when unset', () => {
    expect(normalizeApiUrl(undefined, true)).toBe('/api/v1');
    expect(normalizeApiUrl('  ', true)).toBe('/api/v1');
  });

  it('falls back to the local API in development when unset', () => {
    expect(normalizeApiUrl(undefined, false)).toBe('http://localhost:8000/api/v1');
  });

  it('keeps relative paths relative, appending /api/v1 when missing', () => {
    expect(normalizeApiUrl('/api/v1', true)).toBe('/api/v1');
    expect(normalizeApiUrl('/', true)).toBe('/api/v1');
  });

  it('still normalizes absolute hosts', () => {
    expect(normalizeApiUrl('share.lakeb2b.com', true)).toBe('https://share.lakeb2b.com/api/v1');
    expect(normalizeApiUrl('https://share.lakeb2b.com/', true)).toBe('https://share.lakeb2b.com/api/v1');
  });
});
