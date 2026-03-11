/**
 * Edge Cases & Error Boundaries (CWS-compliant version)
 * Tests that need MOCKED module dependencies (backendApi, fleetedgeLink).
 *
 * IMPORTANT: Each describe block uses vi.doMock() (not hoisted) and
 * vi.resetModules() for proper test isolation.
 *
 * DO NOT SKIP THESE TESTS.
 *     timedFetch timeout -> extension hangs forever waiting for backend.
 *     401 clear-auth path -> user stuck in infinite re-login loop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// SECTION 1: backendApi.js Edge Cases
describe('backendApi - edge cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupBackendApi(fetchMock) {
    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((keys) => {
            const store = { authToken: 'jwt-123', backendUrl: 'http://localhost:3000' };
            const result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach(k => {
              if (k in store) result[k] = store[k];
            });
            return Promise.resolve(result);
          }),
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    return import('../backendApi.js');
  }

  it('timedFetch rejects with descriptive message on timeout (AbortError)', async () => {
    const mod = await setupBackendApi(vi.fn().mockImplementation((_url, opts) => {
      return new Promise((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }));
    await expect(mod.backendFetch('/status')).rejects.toThrow('timed out');
  }, 20000);

  it('login throws when response.json() has no data.token', async () => {
    const mod = await setupBackendApi(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
    }));
    await expect(mod.login('test@test.com', 'pass')).rejects.toThrow();
  });

  it('401 response from backendFetch clears auth state', async () => {
    const mod = await setupBackendApi(vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ message: 'Token expired' }),
    }));
    await expect(mod.backendFetch('/status')).rejects.toThrow();
    expect(chrome.storage.local.remove).toHaveBeenCalledWith(['authToken', 'authUser']);
  });

  it('fetchVehiclesFromBackend returns empty array when data.vehicles is missing', async () => {
    const mod = await setupBackendApi(vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
    }));
    const result = await mod.fetchVehiclesFromBackend();
    expect(result).toEqual([]);
  });

  it('backendFetch includes Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: {} }),
    });
    const mod = await setupBackendApi(mockFetch);
    await mod.backendFetch('/fleetedge/status');

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer jwt-123');
  });
});

// SECTION 2: fleetedgeLink.js Edge Cases
describe('fleetedgeLink - edge cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupFleetedgeLink(opts = {}) {
    const { tabsResult = [], sendMessageResult = null, backendFetchResult = null } = opts;
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
          remove: vi.fn(() => Promise.resolve()),
        },
      },
      tabs: {
        query: vi.fn(() => Promise.resolve(tabsResult)),
        sendMessage: vi.fn(() => Promise.resolve(sendMessageResult)),
      },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    });

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(() => {
        if (backendFetchResult) {
          return Promise.resolve({
            json: () => Promise.resolve(backendFetchResult),
          });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ data: { success: true, vehicleCount: 0 } }),
        });
      }),
    }));

    return import('../fleetedgeLink.js');
  }

  it('connectFleetEdge returns error when no FleetEdge tab is open', async () => {
    const mod = await setupFleetedgeLink({ tabsResult: [] });
    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No FleetEdge tab');
  });

  it('connectFleetEdge returns error when content script cannot read token', async () => {
    const mod = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: { success: false, error: 'No token found' },
    });
    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(false);
    expect(result.error).toContain('No token found');
  });

  it('connectFleetEdge succeeds when content script returns valid token', async () => {
    const mod = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'eyJhbGciOiJSUzI1NiJ9.eyJmbGVldF9pZCI6IkYxMjMiLCJleHAiOjk5OTk5OTk5OTl9.sig',
        fleetId: 'F123',
        exp: 9999999999,
        foundIn: 'localStorage:kc-access',
      },
      backendFetchResult: { data: { success: true, vehicleCount: 15, expiresAt: 9999999999 } },
    });
    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(true);
    expect(result.vehicleCount).toBe(15);
  });

  it('connectFleetEdge handles sendMessage error gracefully', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

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
          remove: vi.fn(() => Promise.resolve()),
        },
      },
      tabs: {
        query: vi.fn(() => Promise.resolve([{ id: 42 }])),
        sendMessage: vi.fn(() => Promise.reject(new Error('Could not establish connection'))),
      },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    });

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(),
    }));

    const mod = await import('../fleetedgeLink.js');
    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not communicate');
  });

  it('disconnectFleetEdge clears local state', async () => {
    const mod = await setupFleetedgeLink();
    const result = await mod.disconnectFleetEdge();
    expect(result.success).toBe(true);
    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });
});
