import { config } from './config.js';
import { getStorage, setStorage, removeStorage } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('BackendAPI');

const FETCH_TIMEOUT_MS = 15_000;

/** Wraps fetch() with an AbortController timeout to prevent hanging requests. */
async function timedFetch(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${options.method || 'GET'} ${url}`);
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

  const store = await getStorage(['backendUrl']);
  const baseUrl = store.backendUrl || config.BACKEND_BASE_URL;
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
    throw new Error(msg);
  }

  const data = await response.json();
  const { token, user } = data.data;

  await setStorage({
    authToken: token,
    authUser: user,
  });

  logger.info(`Logged in as ${user.name} (${user.role})`);
  return { token, user };
}

export async function logout() {
  await removeStorage(['authToken', 'authUser']);
  logger.info('Logged out');
}

// ─── Backend fetch with auth ─────────────────────────────────────────────────

async function backendFetch(path, options = {}) {
  const store = await getStorage(['backendUrl', 'authToken']);
  const baseUrl = store.backendUrl || config.BACKEND_BASE_URL;
  const token = store.authToken;
  const url = `${baseUrl}${config.API_PREFIX}${path}`;

  if (!token) {
    throw new Error('Not authenticated — please log in first');
  }

  const response = await timedFetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  // If 401, clear auth state
  if (response.status === 401) {
    logger.warn('Received 401 — clearing auth state');
    await removeStorage(['authToken', 'authUser']);
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Backend ${options.method || 'GET'} ${path} failed: ${response.status}`);
  }

  return response;
}

// ─── Task APIs ───────────────────────────────────────────────────────────────

export async function fetchPendingTasks() {
  logger.info('Fetching pending tasks');

  try {
    const response = await backendFetch('/tasks/pending');
    const data = await response.json();
    const tasks = data.data?.tasks || [];
    logger.info(`Fetched ${tasks.length} pending task(s)`);
    return tasks;
  } catch (err) {
    logger.error('Failed to fetch tasks:', err.message);
    throw err;
  }
}

export async function submitTaskResult(taskId, results) {
  logger.info(`Submitting result for task ${taskId}`);

  try {
    const response = await backendFetch(`/tasks/${taskId}/result`, {
      method: 'POST',
      body: JSON.stringify({
        fuel_consumed: results.totalFuelConsumed,
        raw_response: results.rawResponse,
      }),
    });

    logger.info(`Task ${taskId} result submitted`);
    return response.json();
  } catch (err) {
    logger.error(`Submit failed for task ${taskId}:`, err.message);
    throw err;
  }
}

export async function reportTaskError(taskId, errorMessage) {
  logger.warn(`Reporting error for task ${taskId}: ${errorMessage}`);

  try {
    await backendFetch(`/tasks/${taskId}/error`, {
      method: 'POST',
      body: JSON.stringify({ error: errorMessage }),
    });
  } catch (err) {
    logger.error(`Failed to report error for task ${taskId}:`, err.message);
  }
}

// ─── Other APIs ──────────────────────────────────────────────────────────────

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
