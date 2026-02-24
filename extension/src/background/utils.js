import { createLogger } from './logger.js';
import { config } from './config.js';

const logger = createLogger('Utils');

/** IST is UTC+5:30 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const DEFAULT_METRICS = {
  totalProcessed: 0,
  totalFailed: 0,
  totalSkipped: 0,
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
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
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
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry(fn, label = 'operation') {
  const maxAttempts = config.MAX_RETRY_ATTEMPTS;
  let lastErr;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isAuthError = err.status === 401 || err.status === 403;
      if (isAuthError || attempt >= maxAttempts) throw err;

      const delay = Math.min(1000 * 2 ** (attempt - 1), 8000);
      logger.warn(`${label} failed (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms: ${err.message}`);
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

export function normalizeRegistration(reg) {
  return (reg || '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Pure function: checks whether a JWT payload's exp claim is valid.
 * @param {object} payload  Decoded JWT payload
 * @param {number} bufferSeconds  Treat as expired if expiry is within this many seconds
 * @returns {{ valid: boolean, remainingSeconds: number }}
 */
export function checkTokenExpiry(payload, bufferSeconds = 60) {
  const exp = payload?.exp;
  if (!exp) return { valid: false, remainingSeconds: 0 };
  const now = Math.floor(Date.now() / 1000);
  const remaining = exp - now;
  if (remaining <= bufferSeconds) return { valid: false, remainingSeconds: Math.max(0, remaining) };
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
