import { describe, expect, it } from 'vitest';
import { ApiError, apiErrorDetail, apiErrorStatus, appendQuery, asArray, dateParams } from './_shared';

describe('apiErrorDetail', () => {
  it('reads a FastAPI string detail', () => {
    expect(apiErrorDetail({ response: { status: 409, data: { detail: 'That slug is taken.' } } })).toBe('That slug is taken.');
  });
  it('joins FastAPI validation errors', () => {
    const err = { response: { status: 422, data: { detail: [{ msg: 'field required' }, { msg: 'too long' }] } } };
    expect(apiErrorDetail(err)).toBe('field required; too long');
  });
  it('falls back to the error message and tolerates non-errors', () => {
    expect(apiErrorDetail(new Error('boom'))).toBe('boom');
    expect(apiErrorDetail(null)).toBeUndefined();
    expect(apiErrorDetail('nope')).toBeUndefined();
  });
});

describe('apiErrorStatus / ApiError', () => {
  it('extracts the HTTP status', () => {
    expect(apiErrorStatus({ response: { status: 413 } })).toBe(413);
    expect(apiErrorStatus(new Error('x'))).toBeUndefined();
  });
  it('ApiError.from normalizes any thrown value', () => {
    const e = ApiError.from({ response: { status: 401, data: { detail: 'Invalid API key' } } });
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(401);
    expect(e.detail).toBe('Invalid API key');
    expect(ApiError.from('weird', 'fallback').detail).toBe('fallback');
    expect(ApiError.from(e)).toBe(e);
  });
});

describe('query helpers', () => {
  it('prefers an explicit date range over days', () => {
    expect(dateParams({ startDate: '2026-01-01', endDate: '2026-01-31', days: 7 }).toString()).toBe(
      'start_date=2026-01-01&end_date=2026-01-31',
    );
    expect(dateParams({ days: 30 }).toString()).toBe('days=30');
    expect(dateParams().toString()).toBe('');
  });
  it('appends only when there is a query', () => {
    expect(appendQuery('/x', new URLSearchParams())).toBe('/x');
    expect(appendQuery('/x', new URLSearchParams({ a: '1' }))).toBe('/x?a=1');
  });
  it('asArray guards non-array payloads', () => {
    expect(asArray<number>([1, 2])).toEqual([1, 2]);
    expect(asArray<number>({ items: [1] })).toEqual([]);
    expect(asArray<number>(undefined)).toEqual([]);
  });
});
