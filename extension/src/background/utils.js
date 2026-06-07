import { createLogger } from './logger.js';
import { config } from './config.js';

const logger = createLogger('Utils');

/** IST is UTC+5:30 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DEFAULT_METRICS = {
  totalProcessed: 0,
  totalFailed: 0,
  lastPollAt: null,
  lastErrorAt: null,
  lastError: null,
};

export function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    const base64Url = parts[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    const json = new TextDecoder().decode(bytes);

    return JSON.parse(json);
  } catch (err) {
    logger.error('Failed to decode JWT:', err.message);
    throw err;
  }
}

export function buildUtcWindow(date, time, windowMinutes = 30) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);

  const istMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0);
  const centerUtcMs = istMs - IST_OFFSET_MS;

  const windowMs = windowMinutes * 60 * 1000;
  const fromUtc = new Date(centerUtcMs - windowMs);
  const toUtc = new Date(centerUtcMs + windowMs);

  const result = { from: formatUtcDatetime(fromUtc), to: formatUtcDatetime(toUtc) };
  logger.debug(`UTC window: ${result.from} → ${result.to}`);
  return result;
}

export function formatUtcDatetime(dt) {
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return (
    `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}` +
    `T${pad(dt.getUTCHours())}:${pad(dt.getUTCMinutes())}:${pad(dt.getUTCSeconds())}` +
    `.${pad(dt.getUTCMilliseconds(), 3)}`
  );
}

export function redactToken(token) {
  if (!token || token.length <= 10) return '***';
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP status codes that should NOT trigger an exponential-backoff retry.
 * - 400/422: malformed request — retrying won't fix it.
 * - 401/403: auth — must re-link, retry just wastes attempts.
 * - 404: resource gone — retry is pointless.
 * - 429: rate-limited — handled specially (Retry-After honored once, then fail).
 */
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 422, 429]);

/** Cap on how long we'll wait for a server-supplied Retry-After before giving up. */
const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Retry an async operation with exponential backoff.
 * - 400/401/403/404/422 fail immediately (NO_RETRY_STATUSES).
 * - 429 fails immediately UNLESS the error carries `retryAfterMs` (set by the
 *   fetch wrapper from the `Retry-After` response header). In that case we wait
 *   that long (capped at MAX_RETRY_AFTER_MS) and retry exactly once.
 * - Other errors: exponential backoff 1s/2s/4s/8s up to MAX_RETRY_ATTEMPTS.
 * @async
 * @param {Function} fn - Async function to execute
 * @param {string} [label='operation'] - Label for logging
 * @returns {Promise<any>} Result from successful fn() call
 * @throws {Error} If all retries exhausted or non-retryable status encountered
 * @example
 * await withRetry(() => fetchPendingTasks(), 'fetch tasks')
 */
export async function withRetry(fn, label = 'operation') {
  const maxAttempts = config.MAX_RETRY_ATTEMPTS;
  let lastErr;
  let used429Retry = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Special-case 429: honor Retry-After once, then fail.
      if (err.status === 429) {
        const retryAfterMs = Number(err.retryAfterMs);
        if (
          !used429Retry &&
          Number.isFinite(retryAfterMs) &&
          retryAfterMs > 0 &&
          attempt < maxAttempts
        ) {
          used429Retry = true;
          const wait = Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
          logger.warn(
            `${label} rate-limited (429), honoring Retry-After ${wait}ms then retrying once`
          );
          await sleep(wait);
          continue;
        }
        // No Retry-After header (or already used our 429 retry) → fail fast.
        throw err;
      }

      if (NO_RETRY_STATUSES.has(err.status) || attempt >= maxAttempts) throw err;

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn(
        `${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${err.message}`
      );
      await sleep(delay);
    }
  }

  throw lastErr;
}

export function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

export function setStorage(data) {
  return chrome.storage.local.set(data);
}

export function removeStorage(keys) {
  return chrome.storage.local.remove(keys);
}

/**
 * Strip special characters from vehicle registration number and convert to uppercase.
 * Matches backend normalization for consistent DB lookups.
 * Example: 'DL1AC-1234*' → 'DL1AC1234'
 * @param {string|null} reg - Vehicle registration number
 * @returns {string} Normalized registration (uppercase alphanumeric only)
 * @example
 * normalizeRegistration('DL-01-AC-1234') // 'DL01AC1234'
 * normalizeRegistration(null) // ''
 */
export function normalizeRegistration(reg) {
  if (!reg) return '';
  return reg.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
}

/**
 * Check whether a JWT payload's exp claim is still valid.
 * Accounts for clock skew via bufferSeconds (default 60s).
 * @param {Object} payload - Decoded JWT payload from decodeJwtPayload()
 * @param {number} [bufferSeconds=60] - Treat as expired if within N seconds of expiry
 * @returns {Object} { valid: boolean, remainingSeconds: number }
 * @example
 * const { valid } = checkTokenExpiry(payload)
 * if (!valid) { // refresh token }
 */
export function checkTokenExpiry(payload, bufferSeconds = 60) {
  const exp = payload?.exp;
  if (!exp || typeof exp !== 'number' || !Number.isFinite(exp)) {
    return { valid: false, remainingSeconds: 0 };
  }
  const now = Math.floor(Date.now() / 1000);
  const remaining = exp - now;
  if (remaining <= bufferSeconds) {
    return { valid: false, remainingSeconds: Math.max(0, remaining) };
  }
  return { valid: true, remainingSeconds: remaining };
}

/**
 * Convert an IST date + time string to a UTC datetime string
 * suitable for FleetEdge API (no window, exact point).
 * @param {string} date  "YYYY-MM-DD"
 * @param {string} time  "HH:MM"
 * @returns {string}     "YYYY-MM-DDTHH:MM:SS.mmm" (UTC)
 */
export function istToUtc(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const utcMs = Date.UTC(y, m - 1, d, hh, mm, 0, 0) - IST_OFFSET_MS;
  return formatUtcDatetime(new Date(utcMs));
}

export async function updateMetrics(updates) {
  const store = await getStorage(['metrics']);
  const metrics = { ...DEFAULT_METRICS, ...store.metrics, ...updates };
  await setStorage({ metrics });
  return metrics;
}

export async function getMetrics() {
  const store = await getStorage(['metrics']);
  return { ...DEFAULT_METRICS, ...store.metrics };
}

/**
 * Derive the display status of a FleetEdge account based on its expiry.
 * Used by both the service worker (badge logic) and the popup UI.
 * @param {Object} account - Account object with status, expiresAt
 * @param {number} [nowMs=Date.now()] - Current timestamp
 * @returns {string} 'linked' | 'expiring' | 'expired'
 */
export function deriveAccountStatus(account, nowMs = Date.now()) {
  if (account.status === 'NEEDS_REAUTH') return 'expired';
  const exp = account.expiresAt ? new Date(account.expiresAt).getTime() : null;
  if (exp == null) return 'linked';
  const rem = (exp - nowMs) / 1000;
  if (rem <= 0) return 'expired';
  if (rem <= 3600) return 'expiring';
  return 'linked';
}
