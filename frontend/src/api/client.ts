import axios, { type AxiosError } from 'axios';
import { authClient } from '../lib/authClient';

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

api.interceptors.response.use(
  (response) => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      const isAuthEndpoint = url.includes('/auth/');
      const onAuthPage = /^\/sign-(in|up)/.test(window.location.pathname);
      // Bounce only when there is genuinely no session. A live session the API still rejects
      // (inactive user, wrong origin) would otherwise loop sign-in -> "/" -> sign-in.
      if (!isAuthEndpoint && !onAuthPage) {
        void authClient.getSession().then(({ data }) => {
          if (!data) window.location.href = '/sign-in';
        });
      }
    }
    return Promise.reject(error);
  }
);

export default api;
