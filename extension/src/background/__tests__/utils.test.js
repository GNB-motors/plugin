/**
 * Unit tests for src/background/utils.js
 *
 * Pure-function tests — no Chrome API needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mocks — must come before importing the module under test ──────────────
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config.js', () => ({ config: { MAX_RETRY_ATTEMPTS: 3 } }));

// Stub chrome for getStorage / setStorage called inside updateMetrics / getMetrics
vi.stubGlobal('chrome', {
  storage: {
    local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn(() => Promise.resolve()) },
  },
});

import {
  istToUtc,
  buildUtcWindow,
  normalizeRegistration,
  formatUtcDatetime,
  checkTokenExpiry,
  withRetry,
} from '../utils.js';

// ─── istToUtc ────────────────────────────────────────────────────────────────
// NOTE: istToUtc returns "YYYY-MM-DDTHH:MM:SS.mmm" (no trailing Z) matching
// the FleetEdge API datetime format.
describe('istToUtc', () => {
  it('converts an IST date+time string to a UTC datetime string (−5h 30m)', () => {
    const result = istToUtc('2026-02-14', '03:20');
    // 03:20 IST = 03:20 − 05:30 = previous day 21:50 UTC
    expect(result).toBe('2026-02-13T21:50:00.000');
  });

  it('handles midnight boundary correctly', () => {
    const result = istToUtc('2026-01-01', '00:00');
    // 00:00 IST = previous day 18:30 UTC
    expect(result).toBe('2025-12-31T18:30:00.000');
  });

  it('handles end-of-day times', () => {
    const result = istToUtc('2026-02-18', '14:50');
    // 14:50 IST = 14:50 − 05:30 = 09:20 UTC
    expect(result).toBe('2026-02-18T09:20:00.000');
  });
});

// ─── buildUtcWindow ──────────────────────────────────────────────────────────
// NOTE: buildUtcWindow returns { from, to } as formatted datetime strings.
describe('buildUtcWindow', () => {
  it('returns from and to separated by 2x the given window minutes', () => {
    const { from, to } = buildUtcWindow('2026-02-14', '12:00', 30);
    // from and to are formatted strings — compare as Dates
    const fromMs = new Date(from + 'Z').getTime();
    const toMs = new Date(to + 'Z').getTime();
    expect(toMs - fromMs).toBe(60 * 60 * 1000); // 30 min each side = 60 min total
  });

  it('centres the window around the given IST time', () => {
    const { from, to } = buildUtcWindow('2026-02-14', '06:30', 60);
    const centreUtc = istToUtc('2026-02-14', '06:30');
    const centreMs = new Date(centreUtc + 'Z').getTime();
    const fromMs = new Date(from + 'Z').getTime();
    const toMs = new Date(to + 'Z').getTime();
    expect(centreMs - fromMs).toBe(60 * 60 * 1000); // 60 min before
    expect(toMs - centreMs).toBe(60 * 60 * 1000); // 60 min after
  });
});

// ─── normalizeRegistration ───────────────────────────────────────────────────
describe('normalizeRegistration', () => {
  it('removes spaces and hyphens, uppercases', () => {
    expect(normalizeRegistration('wb 25-R9640')).toBe('WB25R9640');
  });

  it('handles already-clean input', () => {
    expect(normalizeRegistration('WB25R9640')).toBe('WB25R9640');
  });

  it('returns empty string for null/undefined', () => {
    expect(normalizeRegistration(null)).toBe('');
    expect(normalizeRegistration(undefined)).toBe('');
  });
});

// ─── formatUtcDatetime ───────────────────────────────────────────────────────
describe('formatUtcDatetime', () => {
  it('formats a Date as "YYYY-MM-DDTHH:MM:SS.mmm" (no Z)', () => {
    const dt = new Date('2026-02-14T09:20:00.000Z');
    const result = formatUtcDatetime(dt);
    expect(result).toBe('2026-02-14T09:20:00.000');
  });
});

// ─── checkTokenExpiry ────────────────────────────────────────────────────────
describe('checkTokenExpiry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns valid=false and remainingSeconds=0 when payload is null', () => {
    expect(checkTokenExpiry(null)).toEqual({ valid: false, remainingSeconds: 0 });
    expect(checkTokenExpiry({})).toEqual({ valid: false, remainingSeconds: 0 });
  });

  it('returns valid=true when token has plenty of time left', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const payload = { exp: now + 3600 }; // expires in 1 hour
    const result = checkTokenExpiry(payload, 60);
    expect(result.valid).toBe(true);
    expect(result.remainingSeconds).toBe(3600);
  });

  it('returns valid=false when token is within buffer window', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const payload = { exp: now + 30 }; // 30s left, buffer=60
    const result = checkTokenExpiry(payload, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(30);
  });

  it('returns valid=false when token is already expired', () => {
    const now = Math.floor(Date.now() / 1000);
    vi.setSystemTime(now * 1000);
    const payload = { exp: now - 100 }; // expired 100s ago
    const result = checkTokenExpiry(payload, 60);
    expect(result.valid).toBe(false);
    expect(result.remainingSeconds).toBe(0);
  });
});

// ─── withRetry ───────────────────────────────────────────────────────────────
describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the operation succeeds on first try', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, 'op')).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on failure and resolves on a later attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('recovered');
    const assertion = expect(withRetry(fn, 'op')).resolves.toBe('recovered');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws after exhausting all retries', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('persistent'));
    const assertion = expect(withRetry(fn, 'op')).rejects.toThrow('persistent');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(3); // MAX_RETRY_ATTEMPTS
  });

  it.each([400, 401, 403, 404, 422])(
    'fails immediately on %i without retrying',
    async (status) => {
      const err = Object.assign(new Error('client'), { status });
      const fn = vi.fn().mockRejectedValue(err);
      const assertion = expect(withRetry(fn, 'op')).rejects.toMatchObject({ status });
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(1);
    }
  );

  it('429 without Retry-After fails fast (no exponential retry)', async () => {
    const err = Object.assign(new Error('rate-limited'), { status: 429 });
    const fn = vi.fn().mockRejectedValue(err);
    const assertion = expect(withRetry(fn, 'op')).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('429 with Retry-After waits the header amount then retries exactly once', async () => {
    const err429 = Object.assign(new Error('rate-limited'), {
      status: 429,
      retryAfterMs: 5_000,
    });
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('ok');

    const assertion = expect(withRetry(fn, 'op')).resolves.toBe('ok');

    // Before waiting Retry-After: only the first attempt has fired.
    await vi.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);

    // After 4.9s: still waiting, no retry yet.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(fn).toHaveBeenCalledTimes(1);

    // After the full 5s: retry fires.
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('429 Retry-After is capped at 60s', async () => {
    const err429 = Object.assign(new Error('rate-limited'), {
      status: 429,
      retryAfterMs: 5 * 60 * 1000, // 5 minutes — should be capped
    });
    const fn = vi.fn().mockRejectedValueOnce(err429).mockResolvedValueOnce('ok');

    const assertion = expect(withRetry(fn, 'op')).resolves.toBe('ok');

    // After 60s the retry should fire (cap), even though header said 5min.
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('429 only retries once even if Retry-After present — second 429 fails fast', async () => {
    const err429 = Object.assign(new Error('rate-limited'), {
      status: 429,
      retryAfterMs: 1_000,
    });
    const fn = vi.fn().mockRejectedValue(err429);
    const assertion = expect(withRetry(fn, 'op')).rejects.toMatchObject({ status: 429 });
    await vi.runAllTimersAsync();
    await assertion;
    // First attempt + one honored retry = 2 calls, then bail.
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
