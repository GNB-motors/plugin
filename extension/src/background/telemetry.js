/**
 * LEMU — Local Event Monitoring Utility
 * ──────────────────────────────────────
 * 7-layer structured telemetry for FleetEdge Chrome Extension.
 * Captures events, collects user environment info, fingerprints errors
 * for deduplication, and ships WARN+ events to backend.
 */

import { config } from './config.js';
import { getStorage, setStorage, redactToken } from './utils.js';

// ─── PII / JWT redaction (H-5) ───────────────────────────────────────────────

const JWT_RE = /^ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/;
const BEARER_JWT_RE = /^Bearer\s+(ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,})$/;
const PII_KEYS = new Set(['email', 'phone', 'firstname', 'lastname', 'name', 'mobile', 'username']);
const MAX_REDACT_DEPTH = 6;

function redactString(value) {
  if (typeof value !== 'string') return value;
  if (JWT_RE.test(value)) return redactToken(value);
  const bearer = value.match(BEARER_JWT_RE);
  if (bearer) return `Bearer ${redactToken(bearer[1])}`;
  return value;
}

/**
 * Recursively redact JWT-shaped strings and known PII keys from event context.
 * Applied at emit time so chrome.storage.local buffer never holds plaintext.
 */
function redactContext(input, depth = 0) {
  if (depth > MAX_REDACT_DEPTH) return input;
  if (input == null) return input;
  if (typeof input === 'string') return redactString(input);
  if (typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((v) => redactContext(v, depth + 1));
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (PII_KEYS.has(key.toLowerCase()) && value != null) {
      out[key] = '***';
    } else {
      out[key] = redactContext(value, depth + 1);
    }
  }
  return out;
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const LAYERS = Object.freeze({
  UI: 'UI', // Popup / content interactions
  MESSAGE: 'MESSAGE', // chrome.runtime messaging
  BACKEND: 'BACKEND', // Backend HTTP calls
  FLEETEDGE: 'FLEETEDGE', // FleetEdge connection & backend proxy status
  STORAGE: 'STORAGE', // chrome.storage operations
  TOKEN: 'TOKEN', // FleetEdge token reading (content script)
  TASK: 'TASK', // Backend-side task processing events
});

export const SEVERITY = Object.freeze({
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4,
});

const SEVERITY_NAMES = Object.keys(SEVERITY);
const STORAGE_KEY = 'lemu_telemetry';
const BREADCRUMB_KEY = 'lemu_breadcrumbs';
const HEALTH_KEY = 'lemu_health';
const ENV_KEY = 'lemu_user_env';
const SHIP_QUEUE_KEY = 'lemu_ship_queue';

// ─── State ───────────────────────────────────────────────────────────────────

let eventBuffer = [];
let shipQueue = [];
let breadcrumbs = [];
let healthCounters = {};
let flushTimer = null;
let shipTimer = null;
let healthTimer = null;
let initialized = false;
let extensionVersion = 'unknown';

// ─── User Environment Collection ─────────────────────────────────────────────

/**
 * Collect user's browser/OS/hardware info.
 * Uses navigator API + chrome.runtime.getPlatformInfo()
 */
async function collectUserEnvironment() {
  const env = {
    collectedAt: new Date().toISOString(),
    // Browser info
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
    language: typeof navigator !== 'undefined' ? navigator.language : 'unknown',
    languages: typeof navigator !== 'undefined' ? [...(navigator.languages || [])] : [],
    cookiesEnabled: typeof navigator !== 'undefined' ? navigator.cookieEnabled : null,
    onLine: typeof navigator !== 'undefined' ? navigator.onLine : null,
    // Hardware
    hardwareConcurrency: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
    deviceMemory: typeof navigator !== 'undefined' ? navigator.deviceMemory || null : null,
    // Screen
    screenWidth: typeof screen !== 'undefined' ? screen.width : null,
    screenHeight: typeof screen !== 'undefined' ? screen.height : null,
    colorDepth: typeof screen !== 'undefined' ? screen.colorDepth : null,
    // Chrome-specific
    extensionVersion,
    manifestVersion: 3,
  };

  // Chrome platform info
  try {
    const platform = await chrome.runtime.getPlatformInfo();
    env.os = platform.os; // 'win', 'mac', 'linux', 'cros', 'android'
    env.arch = platform.arch; // 'arm', 'x86-32', 'x86-64', 'mips', 'mips64'
  } catch {
    env.os = 'unknown';
    env.arch = 'unknown';
  }

  // Parse browser from UA string
  env.browser = parseBrowserFromUA(env.userAgent);

  // Connection info (if available)
  if (typeof navigator !== 'undefined' && navigator.connection) {
    env.connection = {
      effectiveType: navigator.connection.effectiveType, // '4g', '3g', etc.
      downlink: navigator.connection.downlink,
      rtt: navigator.connection.rtt,
      saveData: navigator.connection.saveData,
    };
  }

  await setStorage({ [ENV_KEY]: env });
  return env;
}

function parseBrowserFromUA(ua) {
  if (!ua) return { name: 'unknown', version: 'unknown' };
  // Order matters — check more specific first
  if (ua.includes('Edg/')) {
    const m = ua.match(/Edg\/([\d.]+)/);
    return { name: 'Edge', version: m?.[1] || 'unknown' };
  }
  if (ua.includes('OPR/') || ua.includes('Opera/')) {
    const m = ua.match(/(?:OPR|Opera)\/([\d.]+)/);
    return { name: 'Opera', version: m?.[1] || 'unknown' };
  }
  if (ua.includes('Brave')) {
    return { name: 'Brave', version: 'unknown' };
  }
  if (ua.includes('Chrome/')) {
    const m = ua.match(/Chrome\/([\d.]+)/);
    return { name: 'Chrome', version: m?.[1] || 'unknown' };
  }
  if (ua.includes('Firefox/')) {
    const m = ua.match(/Firefox\/([\d.]+)/);
    return { name: 'Firefox', version: m?.[1] || 'unknown' };
  }
  return { name: 'unknown', version: 'unknown' };
}

// ─── Error Fingerprinting ────────────────────────────────────────────────────

/**
 * Create a dedup fingerprint for an error event.
 * Strips dynamic data (IDs, numbers, timestamps) to group similar errors.
 */
export function computeFingerprint(layer, errorName, message) {
  const normalized = String(message || '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.Z]+/g, '<TS>') // ISO timestamps (before numbers!)
    .replace(/[0-9a-f]{8,}/gi, '<ID>') // hex IDs
    .replace(/\d{4,}/g, '<NUM>') // long numbers
    .replace(/https?:\/\/[^\s]+/g, '<URL>') // URLs
    .trim()
    .slice(0, 200);

  return `${layer}::${errorName || 'Error'}::${normalized}`;
}

// ─── Core Event Builder ──────────────────────────────────────────────────────

function buildEvent(layer, severity, message, extra = {}) {
  const severityLevel = typeof severity === 'string' ? SEVERITY[severity] : severity;
  const severityName = SEVERITY_NAMES[severityLevel] || 'INFO';

  // Skip if below minimum
  const minLevel = SEVERITY[config.TELEMETRY_MIN_SEVERITY] || 0;
  if (severityLevel < minLevel) return null;

  // Preserve raw error for stack/name extraction; redact the rest of the context.
  const { error: rawError, ...restExtra } = extra || {};
  const safeExtra = redactContext(restExtra);
  const safeMessage = redactString(String(message)).slice(0, 2000);

  const event = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ts: Date.now(),
    layer,
    severity: severityName,
    severityLevel,
    message: safeMessage,
    extensionVersion,
    ...safeExtra,
  };

  // Error-specific fields
  if (severityLevel >= SEVERITY.ERROR && rawError) {
    const err = rawError instanceof Error ? rawError : new Error(String(rawError));
    event.errorName = err.name;
    const rawStack = err.stack?.slice(0, 4000) || '';
    // Redact JWT-shaped substrings from stack traces / error messages.
    event.stack = rawStack.replace(
      /ey[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
      (m) => redactToken(m),
    );
    event.fingerprint = computeFingerprint(layer, err.name, safeMessage);
    delete event.error; // Don't store raw error object
  } else if (severityLevel >= SEVERITY.WARN) {
    event.fingerprint = computeFingerprint(layer, 'Warning', safeMessage);
  }

  return event;
}

// ─── Breadcrumbs (trail of last 50 actions) ──────────────────────────────────

function addBreadcrumb(layer, message) {
  breadcrumbs.push({
    ts: Date.now(),
    layer,
    message: String(message).slice(0, 200),
  });
  if (breadcrumbs.length > 50) breadcrumbs.shift();
}

export function getBreadcrumbs() {
  return [...breadcrumbs];
}

// ─── Health Counters ─────────────────────────────────────────────────────────

function bumpHealthCounter(layer, severity) {
  const key = `${layer}.${severity}`;
  healthCounters[key] = (healthCounters[key] || 0) + 1;
}

export async function getHealthSnapshot() {
  const store = await getStorage([HEALTH_KEY, ENV_KEY]);
  return {
    counters: { ...healthCounters },
    upSince: store[HEALTH_KEY]?.upSince || new Date().toISOString(),
    lastSnapshot: new Date().toISOString(),
    environment: store[ENV_KEY] || null,
  };
}

async function persistHealthSnapshot() {
  const snapshot = await getHealthSnapshot();
  await setStorage({ [HEALTH_KEY]: snapshot });
}

// ─── Performance Tracking ────────────────────────────────────────────────────

const perfTimers = new Map();

export function perfStart(label) {
  perfTimers.set(label, performance.now());
}

export function perfEnd(label, layer = LAYERS.TASK) {
  const start = perfTimers.get(label);
  if (start === undefined) return null;
  perfTimers.delete(label);
  const durationMs = Math.round(performance.now() - start);

  record(layer, 'DEBUG', `perf: ${label} took ${durationMs}ms`, { durationMs, perfLabel: label });
  return durationMs;
}

// ─── Main Record Function ────────────────────────────────────────────────────

export function record(layer, severity, message, extra = {}) {
  if (!config.TELEMETRY_ENABLED) return null;

  const event = buildEvent(layer, severity, message, extra);
  if (!event) return null;

  // Attach breadcrumbs to errors
  if (event.severityLevel >= SEVERITY.ERROR) {
    event.breadcrumbs = getBreadcrumbs();
  }

  // Add breadcrumb for WARN+
  if (event.severityLevel >= SEVERITY.WARN) {
    addBreadcrumb(layer, message);
  } else {
    addBreadcrumb(layer, message);
  }

  // Bump health counters
  bumpHealthCounter(layer, event.severity);

  // Buffer locally
  eventBuffer.push(event);

  // Queue WARN+ for backend shipping
  if (config.TELEMETRY_SHIP_TO_BACKEND && event.severityLevel >= SEVERITY.WARN) {
    shipQueue.push(event);
  }

  // Immediate ship for FATAL
  if (event.severityLevel >= SEVERITY.FATAL) {
    shipToBackend();
  }

  scheduleFlush();
  return event;
}

// ─── Layer Loggers (convenience) ─────────────────────────────────────────────

export function createLayerLogger(layer) {
  return {
    debug: (msg, extra) => record(layer, 'DEBUG', msg, extra),
    info: (msg, extra) => record(layer, 'INFO', msg, extra),
    warn: (msg, extra) => record(layer, 'WARN', msg, extra),
    error: (msg, extra) => record(layer, 'ERROR', msg, extra),
    fatal: (msg, extra) => record(layer, 'FATAL', msg, extra),
    perfStart: (label) => perfStart(label),
    perfEnd: (label) => perfEnd(label, layer),
  };
}

// ─── Storage Flush ───────────────────────────────────────────────────────────

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, config.TELEMETRY_FLUSH_INTERVAL_MS);
}

async function flush() {
  flushTimer = null;
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer.splice(0);
  try {
    const store = await getStorage([STORAGE_KEY]);
    const events = store[STORAGE_KEY] || [];
    events.push(...batch);

    // Trim to max — keep newest, but always keep unresolved errors
    if (events.length > config.TELEMETRY_MAX_EVENTS) {
      const overflow = events.length - config.TELEMETRY_MAX_EVENTS;
      // Remove oldest non-error events first
      let removed = 0;
      for (let i = 0; i < events.length && removed < overflow; i++) {
        if (events[i].severityLevel < SEVERITY.ERROR) {
          events.splice(i, 1);
          removed++;
          i--;
        }
      }
      // If still over, remove oldest remaining
      if (events.length > config.TELEMETRY_MAX_EVENTS) {
        events.splice(0, events.length - config.TELEMETRY_MAX_EVENTS);
      }
    }

    await setStorage({ [STORAGE_KEY]: events });
  } catch (err) {
    console.error('[LEMU] Flush failed:', err);
  }
}

// ─── Backend Shipping ────────────────────────────────────────────────────────

function scheduleShip() {
  if (shipTimer) return;
  shipTimer = setTimeout(shipToBackend, config.TELEMETRY_SHIP_INTERVAL_MS);
}

async function shipToBackend() {
  shipTimer = null;
  if (shipQueue.length === 0) return;

  const batch = shipQueue.splice(0, config.TELEMETRY_SHIP_BATCH_SIZE);
  try {
    const store = await getStorage(['backendUrl', 'authToken', ENV_KEY]);
    const baseUrl = store.backendUrl || config.BACKEND_BASE_URL;
    const token = store.authToken;

    if (!token) {
      // Re-queue — we'll try again next cycle
      shipQueue.unshift(...batch);
      scheduleShip();
      return;
    }

    const url = `${baseUrl}${config.API_PREFIX}${config.TELEMETRY_BACKEND_ENDPOINT}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.FETCH_TIMEOUT_MS);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          events: batch,
          environment: store[ENV_KEY] || null,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        console.warn(`[LEMU] Ship failed (${res.status}) — re-queuing ${batch.length} events`);
        shipQueue.unshift(...batch);
      }
    } catch {
      clearTimeout(timer);
      // Re-queue on network failure
      shipQueue.unshift(...batch);
    }
  } catch {
    shipQueue.unshift(...batch);
  }

  // Persist queue in case service worker restarts
  try {
    await setStorage({ [SHIP_QUEUE_KEY]: shipQueue.slice(0, 200) });
  } catch {
    /* persist non-critical */
  }

  if (shipQueue.length > 0) scheduleShip();
}

// ─── Query / Export Functions ────────────────────────────────────────────────

export async function getEvents(filters = {}) {
  await flush(); // Ensure buffer is written
  const store = await getStorage([STORAGE_KEY]);
  let events = store[STORAGE_KEY] || [];

  if (filters.layer) events = events.filter((e) => e.layer === filters.layer);
  if (filters.severity)
    events = events.filter((e) => e.severityLevel >= SEVERITY[filters.severity]);
  if (filters.since) events = events.filter((e) => e.ts >= filters.since);
  if (filters.search)
    events = events.filter((e) => e.message.toLowerCase().includes(filters.search.toLowerCase()));
  if (filters.limit) events = events.slice(-filters.limit);

  return events;
}

export async function clearEvents() {
  eventBuffer = [];
  shipQueue = [];
  breadcrumbs = [];
  healthCounters = {};
  await setStorage({ [STORAGE_KEY]: [], [SHIP_QUEUE_KEY]: [], [BREADCRUMB_KEY]: [] });
}

export async function getStats() {
  const events = await getEvents();
  const byLayer = {};
  const bySeverity = {};
  const byFingerprint = {};

  for (const e of events) {
    byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] || 0) + 1;
    if (e.fingerprint) {
      byFingerprint[e.fingerprint] = (byFingerprint[e.fingerprint] || 0) + 1;
    }
  }

  return {
    total: events.length,
    byLayer,
    bySeverity,
    byFingerprint,
    oldestEvent: events[0]?.timestamp || null,
    newestEvent: events.at(-1)?.timestamp || null,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

export async function startTelemetry() {
  if (initialized) return;
  initialized = true;

  try {
    extensionVersion = chrome.runtime.getManifest().version;
  } catch {
    extensionVersion = 'unknown';
  }

  // Collect user environment on startup
  try {
    await collectUserEnvironment();
  } catch {
    // Non-blocking
  }

  // Restore ship queue from storage (in case SW restarted)
  try {
    const store = await getStorage([SHIP_QUEUE_KEY]);
    shipQueue = store[SHIP_QUEUE_KEY] || [];
  } catch {
    /* storage read non-critical */
  }

  // Start shipping timer
  if (config.TELEMETRY_SHIP_TO_BACKEND) {
    scheduleShip();
  }

  // Health snapshots
  healthTimer = setInterval(persistHealthSnapshot, config.TELEMETRY_HEALTH_CHECK_INTERVAL_MS);

  record(LAYERS.TASK, 'INFO', `LEMU telemetry started — v${extensionVersion}`);
}

// ─── Exports for testing ─────────────────────────────────────────────────────

export const _internals = {
  get eventBuffer() {
    return eventBuffer;
  },
  get shipQueue() {
    return shipQueue;
  },
  get breadcrumbs() {
    return breadcrumbs;
  },
  get healthCounters() {
    return healthCounters;
  },
  flush,
  shipToBackend,
  collectUserEnvironment,
  parseBrowserFromUA,
  resetForTest() {
    eventBuffer = [];
    shipQueue = [];
    breadcrumbs = [];
    healthCounters = {};
    initialized = false;
    flushTimer && clearTimeout(flushTimer);
    shipTimer && clearTimeout(shipTimer);
    healthTimer && clearInterval(healthTimer);
    flushTimer = null;
    shipTimer = null;
    healthTimer = null;
  },
};
