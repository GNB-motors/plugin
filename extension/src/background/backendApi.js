import { config } from './config.js';
import { getStorage, setStorage, removeStorage } from './utils.js';
import { createLogger } from './logger.js';
import { createLayerLogger, LAYERS } from './telemetry.js';

const logger = createLogger('BackendAPI');
const bTel = createLayerLogger(LAYERS.BACKEND);

/** Wraps fetch() with an AbortController timeout to prevent hanging requests. */
async function timedFetch(url, options = {}) {
  const timeoutMs = config.FETCH_TIMEOUT_MS || 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s: ${options.method || 'GET'} ${url}`
      );
    }
    if (err.message === 'Failed to fetch') {
      throw new Error(`Backend unreachable (${url}). Is the server running?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Auth helpers ────────────────────────────────────────────────────────────

export async function getAuthToken() {
  const store = await getStorage(['authToken']);
  return store.authToken || null;
}

export async function isAuthenticated() {
  const token = await getAuthToken();
  return !!token;
}

/**
 * Login to the backend using DB credentials.
 * Stores authToken and user info in extension storage.
 */
export async function login(emailOrMobile, password) {
  logger.info('Logging in to backend...');
  bTel.perfStart('login');

  let baseUrl = config.BACKEND_BASE_URL;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  const url = `${baseUrl}${config.API_PREFIX}/auth/login`;

  const response = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailOrMobile, password }),
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const msg = body.message || `Login failed: ${response.status}`;
    logger.error(msg);
    bTel.error('Login failed', { status: response.status, message: msg });
    bTel.perfEnd('login');
    throw new Error(msg);
  }

  const data = await response.json();
  const token = data.data?.token;
  const user = data.data?.user;

  if (!token) {
    bTel.error('Login response missing token');
    bTel.perfEnd('login');
    throw new Error('Login failed: server response missing token');
  }

  await setStorage({
    authToken: token,
    authUser: user,
  });

  logger.info(`Logged in as ${user?.name || 'unknown'} (${user?.role || 'unknown'})`);
  bTel.info('Login successful', { user: user?.name, role: user?.role });
  bTel.perfEnd('login');
  return { token, user };
}

export async function logout() {
  await removeStorage(['authToken', 'authUser']);
  logger.info('Logged out');
  bTel.info('Logged out');
}

// ─── Backend fetch with auth ─────────────────────────────────────────────────

/**
 * Authenticated fetch to the backend. Exported so other modules (fleetedgeLink.js)
 * can reuse it for FleetEdge proxy endpoints.
 */
export async function backendFetch(path, options = {}) {
  const store = await getStorage(['authToken']);
  let baseUrl = config.BACKEND_BASE_URL;
  if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
  const token = store.authToken;
  const url = `${baseUrl}${config.API_PREFIX}${path}`;

  if (!token) {
    throw new Error('Not authenticated — please log in first');
  }

  const isGet = !options.method || options.method.toUpperCase() === 'GET';
  const fetchUrl = isGet ? `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}` : url;

  const response = await timedFetch(fetchUrl, {
    ...options,
    cache: 'no-store', // explicitly disable extension cache
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // If 401, clear auth state
  if (response.status === 401) {
    logger.warn('Received 401 — clearing auth state');
    bTel.warn('Received 401 — session expired', { path });
    await removeStorage(['authToken', 'authUser']);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    bTel.error(`Backend ${options.method || 'GET'} ${path} failed`, { status: response.status });
    const err = new Error(
      body.message || `Backend ${options.method || 'GET'} ${path} failed: ${response.status}`
    );
    err.status = response.status;
    // Parse Retry-After (seconds-as-integer per RFC 7231; HTTP-date form also
    // supported) so withRetry can honor 429 backpressure once before failing.
    if (response.status === 429) {
      const raw = response.headers?.get?.('Retry-After');
      const ms = parseRetryAfter(raw);
      if (ms != null) err.retryAfterMs = ms;
    }
    throw err;
  }

  return response;
}

/**
 * Parse a Retry-After header value into milliseconds.
 * Accepts integer seconds ("60") or HTTP-date. Returns null if unparseable.
 */
function parseRetryAfter(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

// ─── Status APIs ─────────────────────────────────────────────────────────────

export async function fetchVehiclesFromBackend() {
  logger.info('Fetching vehicles from backend');
  const response = await backendFetch('/vehicles');
  const data = await response.json();
  return data.data?.vehicles || [];
}

export async function fetchStatus() {
  const response = await backendFetch('/status');
  return response.json();
}
