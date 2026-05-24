/**
 * Unit tests for src/background/backendApi.js
 *
 * Mocks: fetch (global), chrome.storage.local, config, logger.
 *
 * Exports tested: login, logout, isAuthenticated, backendFetch,
 *                 fetchVehiclesFromBackend, fetchStatus
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub ─────────────────────────────────────────────────────────────
const STORE = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn((keys) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
          if (k in STORE) result[k] = STORE[k];
        });
        return Promise.resolve(result);
      }),
      set: vi.fn((obj) => {
        Object.assign(STORE, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete STORE[k]);
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

const { login, logout, isAuthenticated, backendFetch, fetchVehiclesFromBackend, fetchStatus } =
  await import('../backendApi.js');

function mockFetch(status, body) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  );
}

beforeEach(() => {
  Object.keys(STORE).forEach((k) => delete STORE[k]);
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

// ─── backendFetch ────────────────────────────────────────────────────────────
describe('backendFetch', () => {
  it('sends Authorization header from storage', async () => {
    STORE.authToken = 'bearer-xyz';
    mockFetch(200, { data: {} });
    await backendFetch('/some-endpoint');
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer bearer-xyz');
  });

  it('uses config.BACKEND_BASE_URL when backendUrl is not in storage', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: {} });
    await backendFetch('/test');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('localhost:3000');
    expect(url).toContain('/api/extension/test');
  });

  it.skip('uses custom backendUrl from storage when present', async () => {
    STORE.authToken = 'jwt-123';
    STORE.backendUrl = 'https://custom-backend.example.com';
    mockFetch(200, { data: {} });
    await backendFetch('/test');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('custom-backend.example.com');
  });

  it('throws when not authenticated', async () => {
    // No authToken in STORE
    await expect(backendFetch('/test')).rejects.toThrow('Not authenticated');
  });

  it('clears auth state on 401 response', async () => {
    STORE.authToken = 'expired-jwt';
    STORE.authUser = { name: 'Test' };
    mockFetch(401, { message: 'Token expired' });
    await expect(backendFetch('/test')).rejects.toThrow();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(['authToken', 'authUser']);
  });

  it('throws on non-OK status', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(500, { message: 'server error' });
    await expect(backendFetch('/test')).rejects.toThrow();
  });

  it('merges custom headers with defaults', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: {} });
    await backendFetch('/test', { headers: { 'X-Custom': 'value' } });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.headers['X-Custom']).toBe('value');
    expect(opts.headers['Authorization']).toBe('Bearer jwt-123');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  it('passes method and body through to fetch', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: {} });
    await backendFetch('/test', {
      method: 'POST',
      body: JSON.stringify({ key: 'val' }),
    });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ key: 'val' });
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

  it('returns [] when data.vehicles is missing', async () => {
    STORE.authToken = 'jwt-123';
    mockFetch(200, { data: {} });
    const result = await fetchVehiclesFromBackend();
    expect(result).toEqual([]);
  });
});

// ─── fetchStatus ─────────────────────────────────────────────────────────────
describe('fetchStatus', () => {
  it('returns parsed JSON from /status endpoint', async () => {
    STORE.authToken = 'jwt-123';
    const statusData = { data: { taskCounts: { pending: 3, completed: 10 } } };
    mockFetch(200, statusData);
    const result = await fetchStatus();
    expect(result).toEqual(statusData);
  });
});

// ─── logout ──────────────────────────────────────────────────────────────────
describe('logout', () => {
  it('removes authToken and authUser from storage', async () => {
    STORE.authToken = 'jwt-123';
    STORE.authUser = { name: 'Test' };
    await logout();
    expect(chrome.storage.local.remove).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases — DO NOT SKIP
// These tests guard against production failure modes discovered in real usage.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  it('login rejects when response.json() has no data.token', async () => {
    mockFetch(200, { data: {} });
    await expect(login('test@test.com', 'pass')).rejects.toThrow('missing token');
  });

  it('login rejects when response has no data object at all', async () => {
    mockFetch(200, { message: 'ok' });
    await expect(login('test@test.com', 'pass')).rejects.toThrow('missing token');
  });

  it('401 from backendFetch clears authToken + authUser from storage', async () => {
    STORE.authToken = 'expired-jwt';
    STORE.authUser = { name: 'Test' };
    mockFetch(401, { message: 'Token expired' });
    await expect(backendFetch('/test')).rejects.toThrow();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(['authToken', 'authUser']);
  });

  it('AbortError from fetch is converted to a descriptive timeout message', async () => {
    STORE.authToken = 'jwt-123';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        return Promise.reject(err);
      })
    );
    await expect(backendFetch('/test')).rejects.toThrow('timed out');
  });
});
