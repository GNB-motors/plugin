/**
 * Unit tests for src/background/backendApi.js
 *
 * Mocks: fetch (global), chrome.storage.local, config, logger.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub ─────────────────────────────────────────────────────────────
const STORE = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn((keys) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (k in STORE) result[k] = STORE[k];
        });
        return Promise.resolve(result);
      }),
      set: vi.fn((obj) => { Object.assign(STORE, obj); return Promise.resolve(); }),
      remove: vi.fn((keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete STORE[k]);
        return Promise.resolve();
      }),
    },
  },
});

vi.mock('../config.js', () => ({
  config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { login, logout, isAuthenticated, fetchPendingTasks, submitTaskResult, reportTaskError, fetchVehiclesFromBackend, fetchStatus: _FetchStatus } = await import('../backendApi.js');

function mockFetch(status, body) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  }));
}

beforeEach(() => {
  Object.keys(STORE).forEach(k => delete STORE[k]);
  vi.restoreAllMocks();
});

// ─── login ────────────────────────────────────────────────────────────────────
describe('login', () => {
  it('stores authToken and authUser on success', async () => {
    mockFetch(200, { data: { token: 'jwt-123', user: { name: 'Test', role: 'OWNER' } } });
    const result = await login('test@example.com', 'pass123');
    expect(result.token).toBe('jwt-123');
    expect(result.user.name).toBe('Test');
    expect(STORE.authToken).toBe('jwt-123');
    expect(STORE.authUser).toMatchObject({ name: 'Test' });
  });

  it('throws on non-OK response', async () => {
    mockFetch(401, { message: 'Invalid credentials' });
    await expect(login('bad@test.com', 'wrong')).rejects.toThrow('Invalid credentials');
  });
});

// ─── isAuthenticated ─────────────────────────────────────────────────────────
describe('isAuthenticated', () => {
  it('returns true when authToken exists in storage', async () => {
    STORE.authToken = 'jwt-123';
    expect(await isAuthenticated()).toBe(true);
  });

  it('returns false when authToken is missing', async () => {
    expect(await isAuthenticated()).toBe(false);
  });
});

// ─── fetchPendingTasks ────────────────────────────────────────────────────────
describe('fetchPendingTasks', () => {
  it('returns task array on success', async () => {
    STORE.authToken = 'jwt-123';
    const tasks = [{ id: '1', vehicle_number: 'WB25R9640' }];
    mockFetch(200, { data: { tasks } });

    const result = await fetchPendingTasks();
    expect(result).toEqual(tasks);
  });

  it('uses config.BACKEND_BASE_URL when backendUrl is not in storage', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: { tasks: [] } });
    await fetchPendingTasks();
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('localhost:3000');
    expect(url).toContain('/api/extension/tasks/pending');
  });

  it('throws when not authenticated', async () => {
    // No authToken in STORE
    await expect(fetchPendingTasks()).rejects.toThrow('Not authenticated');
  });

  it('throws when the server returns a non-OK status', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(500, { message: 'server error' });
    await expect(fetchPendingTasks()).rejects.toThrow();
  });
});

// ─── submitTaskResult ────────────────────────────────────────────────────────
describe('submitTaskResult', () => {
  it('sends fuel_consumed and raw_response in the request body', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: { consumption: {} } });

    await submitTaskResult('task-99', { totalFuelConsumed: 42, rawResponse: { results: [] } });

    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/tasks/task-99/result');
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ fuel_consumed: 42, raw_response: { results: [] } });
  });

  it('includes the Authorization header from storage', async () => {
    STORE.authToken = 'bearer-xyz';
    mockFetch(200, { data: {} });
    await submitTaskResult('task-1', { totalFuelConsumed: 0, rawResponse: {} });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer bearer-xyz');
  });
});

// ─── reportTaskError ─────────────────────────────────────────────────────────
describe('reportTaskError', () => {
  it('does not throw even when the backend returns an error', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(500, { message: 'fail' });
    await expect(reportTaskError('task-1', 'something went wrong')).resolves.not.toThrow();
  });

  it('does not throw when fetch itself rejects (network error)', async () => {
    STORE.authToken = 'jwt-123';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await expect(reportTaskError('task-1', 'error')).resolves.not.toThrow();
  });
});

// ─── fetchVehiclesFromBackend ────────────────────────────────────────────────
describe('fetchVehiclesFromBackend', () => {
  it('returns vehicles array from response data', async () => {
    STORE.authToken = 'jwt-123';
    const vehicles = [{ id: 'v1', registrationNumber: 'WB25R9640' }];
    mockFetch(200, { data: { vehicles } });
    const result = await fetchVehiclesFromBackend();
    expect(result).toEqual(vehicles);
  });
});

// ─── logout ──────────────────────────────────────────────────────────────────
describe('logout', () => {
  it('removes authToken and authUser from storage', async () => {
    STORE.authToken = 'jwt-123';
    STORE.authUser = { name: 'Test' };
    await logout();
    // chrome.storage.local.remove is mocked — verify it was called
    expect(chrome.storage.local.remove).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases — ⚠️ DO NOT SKIP
// These tests guard against production failure modes discovered in real usage.
// Skipping these has historically caused:
//   • Silent undefined token storage → infinite re-login loops
//   • Service worker hanging forever on backend timeouts
//   • Stale auth state after 401 → user stuck until manual cache clear
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  // WHY THIS MATTERS: If the backend returns an unexpected response shape (e.g.
  // { data: {} } with no token), the old code would silently store undefined as
  // the auth token and then crash on user.name. The fix validates the response.
  it('login rejects when response.json() has no data.token', async () => {
    mockFetch(200, { data: {} });
    await expect(login('test@test.com', 'pass')).rejects.toThrow('missing token');
  });

  it('login rejects when response has no data object at all', async () => {
    mockFetch(200, { message: 'ok' });
    await expect(login('test@test.com', 'pass')).rejects.toThrow('missing token');
  });

  // WHY THIS MATTERS: A 401 that doesn't clear auth state causes the user to
  // get stuck — every subsequent request sends the expired token and gets 401
  // again. Clearing storage forces a fresh login flow.
  it('401 from fetchPendingTasks clears authToken + authUser from storage', async () => {
    STORE.authToken = 'expired-jwt';
    STORE.authUser = { name: 'Test' };
    mockFetch(401, { message: 'Token expired' });

    await expect(fetchPendingTasks()).rejects.toThrow();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(['authToken', 'authUser']);
  });

  // WHY THIS MATTERS: If the backend returns { data: {} } without a vehicles
  // array, the code must return [] — not crash with "cannot iterate undefined".
  it('fetchVehiclesFromBackend returns [] when data.vehicles is missing', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: {} });
    const result = await fetchVehiclesFromBackend();
    expect(result).toEqual([]);
  });

  // WHY THIS MATTERS: If the backend hangs (e.g. database lock, network partition),
  // the extension service worker stays stuck forever. The 15s AbortController timeout
  // ensures the request fails with a clear error. Without this, Chrome kills the
  // service worker after 5 minutes — silently losing the in-flight operation.
  it('AbortError from fetch is converted to a descriptive timeout message', async () => {
    STORE.authToken = 'jwt-123';

    vi.stubGlobal('fetch', vi.fn(() => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }));

    await expect(fetchPendingTasks()).rejects.toThrow('timed out');
  });
});
