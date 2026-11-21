import { describe, expect, it } from 'vitest';
import { formatElapsed, journeyHops } from './journeyHops';
import type { JourneyTouch } from '../api/journeys';

const touch = (minutes: number, changes: Partial<JourneyTouch> = {}): JourneyTouch => ({
  at: new Date(Date.UTC(2026, 10, 1) + minutes * 60_000).toISOString(),
  asset: { id: 'fixture', type: 'file', title: 'Pitch.pdf', url: '/f/fixture' },
  city: 'Bangalore', country_code: 'IN', lat: 12.97, lon: 77.59, device_type: 'desktop', count: 1,
  ...changes,
});

describe('journeyHops', () => {
  it('compresses elapsed time monotonically, including a three-week gap', () => {
    const hops = journeyHops([touch(0), touch(60), touch(3120), touch(30240)]);
    const values = hops.map((hop) => (hop.rtt[0] ?? 0));
    expect(values).toEqual([...values].sort((a, b) => a - b));
    expect((values.at(-1) ?? 0) * 0.01).toBeLessThan(2);
    expect(hops[2]?.display).toBe('+2d 4h');
  });
  it.each([[0, '+0m'], [59_000, '+0m'], [120_000, '+2m'], [3_660_000, '+1h 1m'], [86_400_000, '+1d']])('formats %s as %s', (ms, display) => {
    expect(formatElapsed(ms)).toBe(display);
  });
  it('keeps an unlocated touch in the ledger without a map point', () => {
    const hops = journeyHops([touch(0), touch(2, { lat: null, lon: null, city: null, country_code: null })]);
    expect(hops).toHaveLength(2);
    expect(hops[1]).toMatchObject({ address: 'Pitch.pdf', name: 'file · desktop', location: 'No location', display: '+2m' });
    expect(hops[1]?.lat).toBeUndefined();
  });
  it('keeps only one map point for a stationary journey, so there is no path', () => {
    const hops = journeyHops([touch(0), touch(60)]);
    expect(hops.filter((hop) => hop.lat !== undefined)).toHaveLength(1);
    expect(hops[1]?.location).toBe('Bangalore, IN');
  });
  it('preserves moves and returns, and does not mutate input', () => {
    const touches = [touch(0), touch(60, { lat: 1.35, lon: 103.82, city: 'Singapore', country_code: 'SG' }), touch(70)];
    const before = structuredClone(touches);
    expect(journeyHops(touches).filter((hop) => hop.lat !== undefined)).toHaveLength(3);
    expect(touches).toEqual(before);
  });
  it('handles empty, invalid geo and out-of-order input without negative elapsed', () => {
    expect(journeyHops([])).toEqual([]);
    const hops = journeyHops([touch(5), touch(0, { lat: 91 })]);
    expect(hops[1]?.display).toBe('+0m');
    expect(hops[1]?.lat).toBeUndefined();
  });
});
