import axios, { type AxiosError } from 'axios';

export function normalizeApiUrl(raw: string | undefined, isProd: boolean = import.meta.env.PROD): string {
  // Unset in a production build means the API is served by the same origin as
  // the SPA (the Cloudflare Worker serves both), so use a relative base URL.
  if (!raw || !raw.trim()) return isProd ? '/api/v1' : 'http://localhost:8000/api/v1';
  let url = raw.trim().replace(/\/+$/, '');
  // A path (e.g. "/api/v1") is same-origin: keep it relative.
  if (raw.trim().startsWith('/')) return /\/api\/v\d+$/i.test(url) ? url : `${url}/api/v1`;
  if (!/^https?:\/\//i.test(url)) {
    console.warn(`VITE_API_URL "${raw}" missing scheme, prepending https://`);
    url = `https://${url}`;
  }
  if (!/\/api\/v\d+$/i.test(url)) {
    console.warn(`VITE_API_URL "${raw}" missing /api/v1 suffix, appending`);
    url = `${url}/api/v1`;
  }
  return url;
}

const rawApiUrl: unknown = import.meta.env.VITE_API_URL;
const API_URL = normalizeApiUrl(typeof rawApiUrl === 'string' ? rawApiUrl : undefined);

export const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

let _tokenGetter: (() => Promise<string | null>) | null = null;

export function setTokenGetter(getter: () => Promise<string | null>) {
  _tokenGetter = getter;
}

api.interceptors.request.use(
  async (config) => {
    if (_tokenGetter) {
      const token = await _tokenGetter();
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error: unknown) => Promise.reject(error instanceof Error ? error : new Error(String(error)))
);

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      const isAuthEndpoint = url.includes('/auth/');
      // Only bounce to sign-in when there is genuinely NO Clerk session. If a
      // session exists but the backend rejected the token (e.g. a Clerk
      // instance / issuer mismatch between this frontend and the API), a
      // full-page redirect to /sign-in — where Clerk immediately sends the
      // signed-in user back to "/" — creates an infinite login loop. In that
      // case surface the error instead and let the UI show it.
      const hasClerkSession = Boolean(
        (window as unknown as { Clerk?: { session?: unknown } }).Clerk?.session
      );
      const onAuthPage = /^\/sign-(in|up)/.test(window.location.pathname);
      if (!isAuthEndpoint && !hasClerkSession && !onAuthPage) {
        window.location.href = '/sign-in';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
