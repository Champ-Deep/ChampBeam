import { describe, expect, it } from 'vitest';
import { formatBytes, formatDwell, formatRelative } from './format';

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2 * 1024 * 1024)).toBe('2.0 MB');
    expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });
  it('never returns negative or NaN', () => {
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });
});

describe('formatDwell', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDwell(0)).toBe('0s');
    expect(formatDwell(12_400)).toBe('12s');
    expect(formatDwell(65_000)).toBe('1m 05s');
    expect(formatDwell(2 * 3_600_000 + 3 * 60_000)).toBe('2h 03m');
  });
});

describe('formatRelative', () => {
  it('uses the fallback for missing or invalid input', () => {
    expect(formatRelative(null)).toBe('never');
    expect(formatRelative('not a date', '--')).toBe('--');
  });
  it('produces a relative phrase for real timestamps', () => {
    expect(formatRelative(new Date(Date.now() - 60_000).toISOString())).toMatch(/minute/);
  });
});
