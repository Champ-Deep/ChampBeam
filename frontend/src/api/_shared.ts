import type { DateRangeOpts } from './utm';

/**
 * Shared, typed helpers for the API modules. One implementation of query
 * building and error parsing instead of per-module copies and
 * `err as { response?: … }` casts.
 */

/** FastAPI error body: `detail` is a string, or a list of validation issues. */
type FastApiDetail = string | Array<{ msg?: string; loc?: unknown[] }> | undefined;

interface AxiosLikeError {
  response?: { status?: number; data?: unknown };
  message?: string;
}

function isAxiosLike(err: unknown): err is AxiosLikeError {
  return typeof err === 'object' && err !== null && ('response' in err || 'message' in err);
}

/** Typed API error with the HTTP status and a human-readable detail. */
export class ApiError extends Error {
  readonly status: number | undefined;
  readonly detail: string;

  constructor(status: number | undefined, detail: string) {
    super(detail);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }

  static from(err: unknown, fallback = 'Request failed.'): ApiError {
    if (err instanceof ApiError) return err;
    return new ApiError(apiErrorStatus(err), apiErrorDetail(err) ?? fallback);
  }
}

/** Extract a readable message from any thrown value (FastAPI-aware). */
export function apiErrorDetail(err: unknown): string | undefined {
  if (err instanceof ApiError) return err.detail;
  if (!isAxiosLike(err)) return err instanceof Error ? err.message : undefined;
  const data = err.response?.data;
  if (typeof data === 'object' && data !== null && 'detail' in data) {
    const detail = (data as { detail?: FastApiDetail }).detail;
    if (typeof detail === 'string') return detail;
    if (Array.isArray(detail)) {
      const msgs = detail.map((d) => d.msg).filter((m): m is string => typeof m === 'string');
      if (msgs.length) return msgs.join('; ');
    }
  }
  return err.message;
}

export function apiErrorStatus(err: unknown): number | undefined {
  if (err instanceof ApiError) return err.status;
  return isAxiosLike(err) ? err.response?.status : undefined;
}

export function asArray<T>(data: unknown): T[] {
  return Array.isArray(data) ? (data as T[]) : [];
}

export function dateParams(opts?: DateRangeOpts): URLSearchParams {
  const params = new URLSearchParams();
  if (opts?.startDate && opts?.endDate) {
    params.append('start_date', opts.startDate);
    params.append('end_date', opts.endDate);
  } else if (opts?.days) {
    params.append('days', opts.days.toString());
  }
  return params;
}

export function appendQuery(base: string, params: URLSearchParams): string {
  const q = params.toString();
  return q ? `${base}?${q}` : base;
}
