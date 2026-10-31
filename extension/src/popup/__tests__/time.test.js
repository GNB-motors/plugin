/**
 * daysUntil — the FleetEdge re-link countdown in the account row.
 * Unknown stays unknown (null), never 0 or "expired".
 */
import { describe, it, expect } from 'vitest';
import { daysUntil } from '../time.js';

const NOW = Date.parse('2026-10-31T00:00:00Z');
const DAY = 86400000;

describe('daysUntil', () => {
  it('counts whole days ahead', () => {
    expect(daysUntil(new Date(NOW + 9 * DAY + 3600000).toISOString(), NOW)).toBe(9);
    expect(daysUntil(new Date(NOW + 12 * 3600000), NOW)).toBe(0);
  });

  it('is negative once the date has passed', () => {
    expect(daysUntil(new Date(NOW - 2 * DAY).toISOString(), NOW)).toBe(-2);
  });

  it('is null when the date is unknown', () => {
    expect(daysUntil(null, NOW)).toBeNull();
    expect(daysUntil(undefined, NOW)).toBeNull();
    expect(daysUntil('', NOW)).toBeNull();
    expect(daysUntil('not a date', NOW)).toBeNull();
  });
});
