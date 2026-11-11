import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('intranet SPA error reporting (NFR-7)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('posts the error to the Worker with message, stack and path', async () => {
    const { reportClientError } = await import('./errorReporting');
    reportClientError('error', new TypeError('x is undefined'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/intranet/client-errors');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ kind: 'error', message: 'x is undefined', path: window.location.pathname });
    expect(body.stack).toContain('TypeError');
  });

  it('drops duplicates and caps reports per page load', async () => {
    const { reportClientError } = await import('./errorReporting');
    reportClientError('error', new Error('same'));
    reportClientError('error', new Error('same'));
    for (let i = 0; i < 10; i++) reportClientError('unhandledrejection', `reason ${i}`);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('reports window errors and unhandled rejections once installed', async () => {
    const { installErrorReporting } = await import('./errorReporting');
    installErrorReporting();
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('render failed'), message: 'render failed' }));
    const rejection = new Event('unhandledrejection') as Event & { reason?: unknown };
    rejection.reason = new Error('promise failed');
    window.dispatchEvent(rejection);
    const kinds = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body)).kind);
    expect(kinds).toEqual(['error', 'unhandledrejection']);
  });
});
