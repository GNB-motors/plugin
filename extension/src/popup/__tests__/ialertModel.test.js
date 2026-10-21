/**
 * Tests for the iALERT popup view-model and the popup's plain-language times.
 */
import { describe, it, expect } from 'vitest';
import { ialertBadge, ialertAccountName, ialertPlanNote } from '../ialertModel.js';
import { ago, until, minutesUntil } from '../time.js';

describe('ialertBadge', () => {
  it('admin state wins over the session state', () => {
    expect(ialertBadge({ accountStatus: 'DISABLED', status: 'ACTIVE' })).toEqual({
      label: 'Disabled by admin',
      tone: 'muted',
    });
    expect(ialertBadge({ accountStatus: 'AUTH_FAILED', status: 'ACTIVE' }).tone).toBe('crit');
  });
  it('a lapsed session renews by itself only when it can', () => {
    expect(ialertBadge({ status: 'NEEDS_REAUTH', canSelfRenew: true })).toEqual({
      label: 'Renewing',
      tone: 'warn',
    });
    expect(ialertBadge({ status: 'NEEDS_REAUTH', canSelfRenew: false })).toEqual({
      label: 'Reconnect needed',
      tone: 'crit',
    });
  });
  it('ACTIVE is connected; anything else is unknown, never raw', () => {
    expect(ialertBadge({ status: 'ACTIVE' })).toEqual({ label: 'Connected', tone: 'ok' });
    expect(ialertBadge({ status: 'WEIRD_STATE' })).toEqual({ label: 'Unknown', tone: 'muted' });
    expect(ialertBadge(null).label).toBe('Unknown');
  });
});

describe('ialertAccountName', () => {
  it('prefers the friendly name, then a readable id', () => {
    expect(ialertAccountName({ friendlyName: 'Depot', externalAccountId: '410001' })).toBe('Depot');
    expect(ialertAccountName({ externalAccountId: '410001' })).toBe('iALERT account 410001');
    expect(ialertAccountName(undefined)).toBe('iALERT account');
  });
});

describe('ialertPlanNote', () => {
  it('names the most urgent bucket only', () => {
    expect(ialertPlanNote({ expired: 2, next15: 1, next30: 4 })).toEqual({
      text: 'Plan expired for 2 vehicles',
      tone: 'crit',
    });
    expect(ialertPlanNote({ expired: 0, next15: 1, next30: 4 })).toEqual({
      text: 'Plan ends within 15 days for 1 vehicle',
      tone: 'warn',
    });
    expect(ialertPlanNote({ expired: 0, next15: 0, next30: 0 })).toBeNull();
    expect(ialertPlanNote(null)).toBeNull();
  });
});

describe('ago / until', () => {
  const NOW = Date.parse('2026-10-21T10:00:00Z');
  it('reads like a sentence, never a clock', () => {
    expect(ago(NOW - 20 * 1000, NOW)).toBe('just now');
    expect(ago(NOW - 4 * 60000, NOW)).toBe('4 min ago');
    expect(ago(NOW - 3 * 3600000, NOW)).toBe('3 h ago');
    expect(ago(NOW - 3 * 86400000, NOW)).toBe('3 days ago');
    expect(until(NOW + 25 * 60000, NOW)).toBe('in 25 min');
    expect(until(NOW - 60000, NOW)).toBe('now');
    expect(minutesUntil(NOW + 42 * 60000, NOW)).toBe(42);
  });
  it('is null when the time is unknown', () => {
    expect(ago(null, NOW)).toBeNull();
    expect(until('not a date', NOW)).toBeNull();
  });
});

describe('describeIalertProblem', () => {
  it('turns each failure into an actionable sentence', async () => {
    const { describeIalertProblem } = await import('../ialertModel.js');
    expect(describeIalertProblem(404, 'x')).toMatch(/doesn't support iALERT yet/);
    expect(describeIalertProblem(401, 'x')).toMatch(/Sign in to GNB/);
    expect(describeIalertProblem(null, 'Not authenticated — please log in first')).toMatch(
      /Sign in to GNB/
    );
    expect(describeIalertProblem(403, 'x')).toMatch(/owner or manager/);
    expect(describeIalertProblem(502, 'x')).toMatch(/server had a problem/);
    expect(describeIalertProblem(null, 'Failed to fetch')).toMatch(/Can't reach the GNB server/);
    // backendFetch's own rewrites never leak the raw text (it carries the URL)
    expect(describeIalertProblem(null, 'Request timed out after 15000ms')).toMatch(
      /Can't reach the GNB server/
    );
    expect(describeIalertProblem(null, 'Backend unreachable (https://api.example/x)')).toMatch(
      /Can't reach the GNB server/
    );
    expect(describeIalertProblem(400, 'This iALERT session is too old')).toBe(
      'This iALERT session is too old'
    );
    expect(describeIalertProblem(null, '')).toMatch(/Press Retry/);
  });
});
