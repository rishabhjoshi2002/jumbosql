import { describe, expect, it } from 'vitest';
import { bytes, compact, daysText, horizonLabel, niceTicks, scoreColor, suggestedCores, unitValue } from './format';

describe('insights formatting', () => {
  it('formats bytes and numbers', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(bytes(-2 * 1024 ** 2)).toBe('-2.0 MB');
    expect(compact(12345)).toBe('12.3K');
    expect(compact(2.5)).toBe('2.5');
    expect(compact(0)).toBe('0');
    expect(compact(15)).toBe('15');
    expect(compact(15.25)).toBe('15.3');
    expect(daysText(-1)).toBeNull();
    expect(daysText(12.4)).toBe('12 days');
  });
  it('makes round axis ticks', () => {
    expect(niceTicks(0, 97)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0, 0)[0]).toBe(0);
    expect(niceTicks(0, 1.2)).toEqual([0, 0.5, 1, 1.5]); // the top tick is above the data
    expect(niceTicks(0, 3.1e6).at(-1)).toBeGreaterThanOrEqual(3.1e6);
  });
  it('suggests CPUs like the server does', () => {
    expect(suggestedCores(4, 60, 70)).toBe(4);
    expect(suggestedCores(4, 85, 100)).toBe(7);
  });
});

describe('capacity helpers', () => {
  it('formats values by unit and horizons in plain words', () => {
    expect(unitValue(1536, 'bytes')).toBe('1.5 KB');
    expect(unitValue(42.4, 'pct')).toBe('42%');
    expect(unitValue(12.5, 'per_sec')).toBe('12.5/s');
    expect(unitValue(99.6, 'count')).toBe('100');
    expect(unitValue(undefined, 'bytes')).toBe('—');
    expect([30, 90, 180, 365].map(horizonLabel)).toEqual(['30 days', '3 months', '6 months', '1 year']);
    expect([90, 60, 10].map(scoreColor)).toEqual(['success', 'warning', 'error']);
  });
});
