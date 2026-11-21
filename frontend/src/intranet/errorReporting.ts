const ENDPOINT = '/api/v1/intranet/client-errors';
const MAX_REPORTS = 5;

let installed = false;
let sent = 0;
const seen = new Set<string>();

export function reportClientError(kind: 'error' | 'unhandledrejection', reason: unknown): void {
  const err = reason instanceof Error ? reason : null;
  const raw = err?.message ?? (typeof reason === 'string' ? reason : '');
  const message = raw.slice(0, 2000) || 'Unknown error';
  if (sent >= MAX_REPORTS || seen.has(message)) return;
  seen.add(message);
  sent += 1;
  void fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, message, stack: err?.stack?.slice(0, 8000), path: window.location.pathname }),
  }).catch(() => undefined);
}

export function installErrorReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => reportClientError('error', e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => reportClientError('unhandledrejection', e.reason));
}
