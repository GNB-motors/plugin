/**
 * FleetEdge Plugin — Utils Edge Cases & Error Boundaries
 * ──────────────────────────────────────────────────────
 * Pure-function tests that use REAL imports (no vi.mock on utils.js).
 * These cover boundary inputs, null/undefined handling, and date arithmetic
 * that have caused silent data corruption in production.
 *
 * ⚠️  DO NOT SKIP THESE TESTS.
 *     redactToken(null) crash → leaked JWTs in Discord alerts.
 *     normalizeRegistration('wb/25.R-9640') mismatch → VIN lookup failures.
 *     buildUtcWindow midnight → fuel data pulled for wrong day.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Module mocks (only for logger + config, NOT utils) ──────────────────────
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config.js', () => ({
  config: {
    MAX_RETRY_ATTEMPTS: 3,
    BACKEND_BASE_URL: 'http://localhost:3000',
    API_PREFIX: '/api/extension',
    CVP_API_BASE: 'https://cvp.api.tatamotors',
    POLL_INTERVAL_MINUTES: 5,
    INTER_TASK_DELAY_MS: 0,
    VIN_CACHE_TTL_HOURS: 24,
    SEARCH_WINDOW_MINUTES: 30,
    TOKEN_EXPIRY_BUFFER_SECONDS: 60,
    FLEETEDGE_ORIGIN: 'https://fleetedge.home.tatamotors',
  },
}));

vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
      remove: vi.fn(() => Promise.resolve()),
    },
  },
});

// ─── Import REAL utils (no mock) ─────────────────────────────────────────────
import {
  decodeJwtPayload,
  buildUtcWindow,
  normalizeRegistration,
  formatUtcDatetime,
  checkTokenExpiry,
  redactToken,
  withRetry,
  istToUtc,
} from '../utils.js';

// ═══════════════════════════════════════════════════════════════════════════════
// decodeJwtPayload
// WHY THIS MATTERS: A crash here means FleetEdge token validation breaks
// silently — no task polling, no fuel data, user sees nothing.
// ═══════════════════════════════════════════════════════════════════════════════

describe('decodeJwtPayload — edge cases', () => {
  it('throws on token with only 2 parts (missing signature)', () => {
    expect(() => decodeJwtPayload('header.payload')).toThrow('Invalid JWT format');
  });

  it('throws on token with 4 parts (malformed)', () => {
    expect(() => decodeJwtPayload('a.b.c.d')).toThrow('Invalid JWT format');
  });

  it('throws on empty string', () => {
    expect(() => decodeJwtPayload('')).toThrow('Invalid JWT format');
  });

  it('throws when payload is not valid base64', () => {
    expect(() => decodeJwtPayload('header.!!!invalid!!!.sig')).toThrow();
  });

  it('throws when payload is valid base64 but not JSON', () => {
    const notJson = btoa('this is not json');
    expect(() => decodeJwtPayload(`header.${notJson}.sig`)).toThrow();
  });

  it('decodes a real JWT payload correctly', () => {
    const payload = { sub: '1234567890', name: 'Test', iat: 1516239022 };
    const encoded = btoa(JSON.stringify(payload));
    const result = decodeJwtPayload(`header.${encoded}.sig`);
    expect(result).toEqual(payload);
  });

  it('handles base64url encoding (- and _ chars)', () => {
    const payload = { key: 'value+with/special' };
    const json = JSON.stringify(payload);
    const b64 = btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const result = decodeJwtPayload(`header.${b64}.sig`);
    expect(result).toEqual(payload);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// redactToken
// WHY THIS MATTERS: Tokens leaked in logs/alerts expose the entire system.
// redactToken is used in every log line that touches auth. A null crash means
// unredacted tokens end up in Discord webhook messages visible to everyone.
// ═══════════════════════════════════════════════════════════════════════════════

describe('redactToken — edge cases', () => {
  it('returns "***" for null', () => {
    expect(redactToken(null)).toBe('***');
  });

  it('returns "***" for undefined', () => {
    expect(redactToken(undefined)).toBe('***');
  });

  it('returns "***" for empty string', () => {
    expect(redactToken('')).toBe('***');
  });

  it('returns "***" for exactly 10-char token (boundary)', () => {
    expect(redactToken('1234567890')).toBe('***');
  });

  it('redacts an 11-char token (first 6 + last 4)', () => {
    expect(redactToken('12345678901')).toBe('123456…8901');
  });

  it('redacts a very long token correctly', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.long.payload';
    const result = redactToken(token);
    expect(result).toBe('eyJhbG…load');
    expect(result).not.toContain('IUzI1NiI');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeRegistration
// WHY THIS MATTERS: This function matches task vehicle_number to VIN map.
// If it doesn't strip separators/lowercase, the VIN lookup fails → task error
// → the driver doesn't get fuel data → manual re-entry (15 min per task).
// BUG FIXED: Previously only stripped spaces and dashes. Now strips ALL
// non-alphanumeric chars (dots, slashes, underscores, etc.)
// ═══════════════════════════════════════════════════════════════════════════════

describe('normalizeRegistration — edge cases', () => {
  it('returns empty string for empty input', () => {
    expect(normalizeRegistration('')).toBe('');
  });

  it('handles input that is only spaces and dashes', () => {
    expect(normalizeRegistration('  --  - -- ')).toBe('');
  });

  it('handles lowercase input', () => {
    expect(normalizeRegistration('wb 25-r9640')).toBe('WB25R9640');
  });

  it('handles tabs and multiple consecutive spaces', () => {
    expect(normalizeRegistration('WB  25  R9640')).toBe('WB25R9640');
  });

  it('strips dots and slashes (BUG FIX: previously kept them)', () => {
    // Before fix: returned 'WB/25.R9640' — broke VIN lookup
    // After fix: returns 'WB25R9640' — correct VIN match
    expect(normalizeRegistration('WB/25.R-9640')).toBe('WB25R9640');
  });

  it('strips underscores', () => {
    expect(normalizeRegistration('WB_25_R_9640')).toBe('WB25R9640');
  });

  it('handles null input', () => {
    expect(normalizeRegistration(null)).toBe('');
  });

  it('handles undefined input', () => {
    expect(normalizeRegistration(undefined)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildUtcWindow
// WHY THIS MATTERS: This converts IST task times to UTC for the FleetEdge API.
// Midnight crossing = wrong day → wrong fuel data → financial misreporting.
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildUtcWindow — edge cases', () => {
  it('handles midnight IST (crosses day boundary)', () => {
    // 00:00 IST = previous day 18:30 UTC, ±30min window
    const { from, to } = buildUtcWindow('2026-01-01', '00:00', 30);
    const fromMs = new Date(from + 'Z').getTime();
    const toMs = new Date(to + 'Z').getTime();
    expect(toMs - fromMs).toBe(60 * 60 * 1000); // 1-hour window
    expect(from).toContain('2025-12-31'); // Crossed into previous day
  });

  it('handles zero window (from === to)', () => {
    const { from, to } = buildUtcWindow('2026-06-15', '12:00', 0);
    expect(from).toBe(to);
  });

  it('handles very large window (720 min = 12 hours each side = 24h total)', () => {
    const { from, to } = buildUtcWindow('2026-06-15', '12:00', 720);
    const fromMs = new Date(from + 'Z').getTime();
    const toMs = new Date(to + 'Z').getTime();
    expect(toMs - fromMs).toBe(24 * 60 * 60 * 1000);
  });

  it('handles single-digit month and day', () => {
    const { from, to } = buildUtcWindow('2026-1-5', '06:30', 30);
    const fromMs = new Date(from + 'Z').getTime();
    const toMs = new Date(to + 'Z').getTime();
    expect(toMs - fromMs).toBe(60 * 60 * 1000);
  });

  it('handles end-of-month rollover (Jan 31)', () => {
    const { to } = buildUtcWindow('2026-01-31', '23:50', 30);
    const toDate = new Date(to + 'Z');
    // 23:50 IST = 18:20 UTC + 30min = 18:50 UTC, still Jan 31
    expect(toDate.getUTCDate()).toBe(31);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// checkTokenExpiry
// WHY THIS MATTERS: This decides "is the FleetEdge token still usable?"
// Off-by-one = expired token used → 401 → retry loop → task timeout.
// BUG FIXED: Previously, exp='string' returned valid:true (NaN arithmetic).
// Now returns valid:false for non-numeric exp.
// ═══════════════════════════════════════════════════════════════════════════════

describe('checkTokenExpiry — edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('exp exactly at buffer boundary returns invalid', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const result = checkTokenExpiry({ exp: now + 60 }, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(60);
  });

  it('exp one second past buffer is valid', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const result = checkTokenExpiry({ exp: now + 61 }, 60);
    expect(result.valid).toBe(true);
    expect(result.remainingSeconds).toBe(61);
  });

  it('handles custom bufferSeconds = 0 (no buffer)', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const result = checkTokenExpiry({ exp: now + 1 }, 0);
    expect(result.valid).toBe(true);
    expect(result.remainingSeconds).toBe(1);
  });

  it('handles very large exp (far future)', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const farFuture = now + 365 * 24 * 3600;
    const result = checkTokenExpiry({ exp: farFuture }, 60);
    expect(result.valid).toBe(true);
    expect(result.remainingSeconds).toBe(365 * 24 * 3600);
  });

  it('handles negative exp (epoch 0 era)', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const result = checkTokenExpiry({ exp: -1 }, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(0);
  });

  it('handles exp = 0', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const result = checkTokenExpiry({ exp: 0 }, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(0);
  });

  it('handles exp as string (BUG FIX: previously returned valid:true)', () => {
    // Before fix: NaN <= 60 is false → returned valid:true
    // After fix: typeof check → returns valid:false
    const result = checkTokenExpiry({ exp: 'not-a-number' }, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(0);
  });

  it('handles missing payload', () => {
    const result = checkTokenExpiry(null, 60);
    expect(result.valid).toBe(false);
  });

  it('handles payload without exp field', () => {
    const result = checkTokenExpiry({ sub: '123' }, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// withRetry
// WHY THIS MATTERS: Retry logic wraps every FleetEdge + backend API call.
// Wrong retry count = wasted time. Retry on 401 = infinite auth loop.
// ═══════════════════════════════════════════════════════════════════════════════

describe('withRetry — edge cases', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('succeeds on the very last attempt (attempt 3 of 3)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('third-time');

    const promise = withRetry(fn, 'test');
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('third-time');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on 401 (auth error)', async () => {
    const err = new Error('Unauthorized');
    err.status = 401;
    const fn = vi.fn().mockRejectedValue(err);

    // Auth errors throw immediately — no timer involved
    await expect(withRetry(fn, 'auth-test')).rejects.toThrow('Unauthorized');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403 (forbidden)', async () => {
    const err = new Error('Forbidden');
    err.status = 403;
    const fn = vi.fn().mockRejectedValue(err);

    // Auth errors throw immediately — no timer involved
    await expect(withRetry(fn, 'forbidden-test')).rejects.toThrow('Forbidden');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('returns the value immediately if function resolves on first try', async () => {
    const fn = vi.fn().mockResolvedValue(42);
    await expect(withRetry(fn, 'instant')).resolves.toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// istToUtc
// WHY THIS MATTERS: Every FleetEdge fuel query uses IST→UTC conversion.
// Off-by-one day = fuel data for wrong date = financial audit failure.
// ═══════════════════════════════════════════════════════════════════════════════

describe('istToUtc — edge cases', () => {
  it('handles leap year date (Feb 29)', () => {
    const result = istToUtc('2028-02-29', '05:30');
    expect(result).toBe('2028-02-29T00:00:00.000');
  });

  it('handles end of year (Dec 31 23:59 IST)', () => {
    const result = istToUtc('2026-12-31', '23:59');
    expect(result).toBe('2026-12-31T18:29:00.000');
  });

  it('handles early morning crossing into previous year', () => {
    const result = istToUtc('2027-01-01', '00:00');
    expect(result).toContain('2026-12-31');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// formatUtcDatetime
// WHY THIS MATTERS: Every FleetEdge API call sends dates in this format.
// Wrong padding (e.g. "2026-1-5" instead of "2026-01-05") → API 400 error.
// ═══════════════════════════════════════════════════════════════════════════════

describe('formatUtcDatetime — edge cases', () => {
  it('formats epoch zero (1970-01-01T00:00:00.000)', () => {
    const result = formatUtcDatetime(new Date(0));
    expect(result).toBe('1970-01-01T00:00:00.000');
  });

  it('pads single-digit months and days', () => {
    const dt = new Date('2026-01-05T03:07:09.005Z');
    const result = formatUtcDatetime(dt);
    expect(result).toBe('2026-01-05T03:07:09.005');
  });

  it('handles last millisecond of the day', () => {
    const dt = new Date('2026-06-15T23:59:59.999Z');
    const result = formatUtcDatetime(dt);
    expect(result).toBe('2026-06-15T23:59:59.999');
  });

  it('handles Feb 29 in a leap year', () => {
    const dt = new Date('2028-02-29T12:00:00.000Z');
    const result = formatUtcDatetime(dt);
    expect(result).toBe('2028-02-29T12:00:00.000');
  });
});
