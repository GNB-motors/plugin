/**
 * Tests for iALERT popup model helpers.
 *
 * Pure logic tests for status mapping, formatting, and label generation.
 */
import { describe, it, expect } from 'vitest';
import {
  mapStatusToChip,
  getChipLabel,
  formatExpiresAt,
  getAccountLabel,
} from '../ialertModel.js';

describe('mapStatusToChip', () => {
  it('maps ACTIVE to ok', () => {
    expect(mapStatusToChip('ACTIVE')).toBe('ok');
  });

  it('maps NEEDS_REAUTH to warn', () => {
    expect(mapStatusToChip('NEEDS_REAUTH')).toBe('warn');
  });

  it('maps REVOKED to muted', () => {
    expect(mapStatusToChip('REVOKED')).toBe('muted');
  });

  it('maps DISABLED to muted', () => {
    expect(mapStatusToChip('DISABLED')).toBe('muted');
  });

  it('maps unknown status to muted', () => {
    expect(mapStatusToChip('SOME_UNKNOWN_STATUS')).toBe('muted');
  });

  it('maps null/undefined to muted', () => {
    expect(mapStatusToChip(null)).toBe('muted');
    expect(mapStatusToChip(undefined)).toBe('muted');
  });
});

describe('getChipLabel', () => {
  it('returns Active for ACTIVE', () => {
    expect(getChipLabel('ACTIVE')).toBe('Active');
  });

  it('returns "Reconnect needed" for NEEDS_REAUTH', () => {
    expect(getChipLabel('NEEDS_REAUTH')).toBe('Reconnect needed');
  });

  it('returns Revoked for REVOKED', () => {
    expect(getChipLabel('REVOKED')).toBe('Revoked');
  });

  it('returns Disabled for DISABLED', () => {
    expect(getChipLabel('DISABLED')).toBe('Disabled');
  });

  it('returns unknown status as-is for unknown values', () => {
    expect(getChipLabel('UNKNOWN')).toBe('UNKNOWN');
  });

  it('returns Unknown for null/undefined', () => {
    expect(getChipLabel(null)).toBe('Unknown');
    expect(getChipLabel(undefined)).toBe('Unknown');
  });
});

describe('formatExpiresAt', () => {
  it('formats valid ISO string to local time', () => {
    // Create a fixed date to avoid timezone issues
    const result = formatExpiresAt('2026-10-20T14:30:00.000Z');
    // Should return time string with colon (e.g., "08:00 pm" or "20:00")
    expect(result).toMatch(/^\d{1,2}:\d{2}/);
  });

  it('returns "—" for null', () => {
    expect(formatExpiresAt(null)).toBe('—');
  });

  it('returns "—" for undefined', () => {
    expect(formatExpiresAt(undefined)).toBe('—');
  });

  it('returns "—" for empty string', () => {
    expect(formatExpiresAt('')).toBe('—');
  });
});

describe('getAccountLabel', () => {
  it('returns friendlyName when present', () => {
    const account = { friendlyName: 'Test User', externalAccountId: 'ext-123' };
    expect(getAccountLabel(account)).toBe('Test User');
  });

  it('falls back to externalAccountId when no friendlyName', () => {
    const account = { externalAccountId: 'ext-456' };
    expect(getAccountLabel(account)).toBe('ext-456');
  });

  it('returns "Unknown" for empty account', () => {
    expect(getAccountLabel({})).toBe('Unknown');
  });

  it('returns "Unknown" for null', () => {
    expect(getAccountLabel(null)).toBe('Unknown');
  });

  it('returns "Unknown" for undefined', () => {
    expect(getAccountLabel(undefined)).toBe('Unknown');
  });
});

describe('describeIalertProblem', () => {
  it('turns each failure into an actionable sentence', async () => {
    const { describeIalertProblem } = await import('../ialertModel.js');
    expect(describeIalertProblem(404, 'x')).toMatch(/doesn't support iALERT yet/);
    expect(describeIalertProblem(401, 'x')).toMatch(/Sign in to GNB/);
    expect(describeIalertProblem(null, 'Not authenticated — please log in first')).toMatch(/Sign in to GNB/);
    expect(describeIalertProblem(403, 'x')).toMatch(/owner or manager/);
    expect(describeIalertProblem(502, 'x')).toMatch(/server had a problem/);
    expect(describeIalertProblem(null, 'Failed to fetch')).toMatch(/Can't reach the GNB server/);
    expect(describeIalertProblem(400, 'This iALERT session is too old')).toBe('This iALERT session is too old');
    expect(describeIalertProblem(null, '')).toMatch(/Press Retry/);
  });
});
