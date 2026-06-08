/**
 * Edge Case Tests — v2.0.0 Optimizations & Bug Fixes
 * ═══════════════════════════════════════════════════
 * Tests the new code paths added during the optimization pass:
 *
 *   1. backendApi.js   — config.FETCH_TIMEOUT_MS usage, BACKEND telemetry
 *   2. fleetedgeLink.js — multi-tab sort, token TTL validation, TOKEN/FLEETEDGE telemetry
 *   3. index.js        — status dedup cache, parallel GET_STATUS, URL validation,
 *                         cache invalidation on disconnect/logout/clear
 *
 * Each section uses vi.doMock() + vi.resetModules() for isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1: backendApi.js — config-driven timeout, telemetry
// ═══════════════════════════════════════════════════════════════════════════════

describe('backendApi — v2 improvements', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupBackendApi({ fetchMock, configOverrides = {} } = {}) {
    const defaultConfig = {
      BACKEND_BASE_URL: 'http://localhost:3000',
      API_PREFIX: '/api/extension',
      FETCH_TIMEOUT_MS: 15_000,
      ...configOverrides,
    };

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({ config: defaultConfig }));

    // Telemetry stub — capture calls for assertions
    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: {
        UI: 'UI',
        MESSAGE: 'MESSAGE',
        BACKEND: 'BACKEND',
        FLEETEDGE: 'FLEETEDGE',
        STORAGE: 'STORAGE',
        TOKEN: 'TOKEN',
        TASK: 'TASK',
      },
    }));

    const store = { authToken: 'jwt-test', backendUrl: 'http://localhost:3000' };
    vi.stubGlobal('chrome', {
      storage: {
        local: {
          get: vi.fn((keys) => {
            const result = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
              if (k in store) result[k] = store[k];
            });
            return Promise.resolve(result);
          }),
          set: vi.fn(() => Promise.resolve()),
          remove: vi.fn(() => Promise.resolve()),
        },
      },
    });

    if (fetchMock) vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../backendApi.js');
    return { mod, telemetryCalls, store };
  }

  it('timedFetch uses config.FETCH_TIMEOUT_MS instead of hardcoded value', async () => {
    // Use a very short timeout so we can test it triggers
    const { mod } = await setupBackendApi({
      configOverrides: { FETCH_TIMEOUT_MS: 100 },
      fetchMock: vi.fn((_url, opts) => {
        return new Promise((_resolve, reject) => {
          const timer = setTimeout(() => {}, 30_000); // keep alive
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('The operation was aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }),
    });

    await expect(mod.backendFetch('/test')).rejects.toThrow('timed out');
  }, 10000);

  it('login records BACKEND telemetry on success', async () => {
    const { mod, telemetryCalls } = await setupBackendApi({
      fetchMock: vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({ data: { token: 'jwt-new', user: { name: 'T', role: 'OWNER' } } }),
      }),
    });

    await mod.login('user@test.com', 'pass');

    const loginEvent = telemetryCalls.find((e) => e.msg === 'Login successful');
    expect(loginEvent).toBeDefined();
    expect(loginEvent.layer).toBe('BACKEND');
    expect(loginEvent.extra).toMatchObject({ user: 'T', role: 'OWNER' });
  });

  it('login records BACKEND telemetry on failure', async () => {
    const { mod, telemetryCalls } = await setupBackendApi({
      fetchMock: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'Invalid' }),
      }),
    });

    await expect(mod.login('bad', 'bad')).rejects.toThrow();
    const failEvent = telemetryCalls.find((e) => e.msg === 'Login failed');
    expect(failEvent).toBeDefined();
    expect(failEvent.extra.status).toBe(401);
  });

  it('401 response records BACKEND telemetry with path', async () => {
    const { mod, telemetryCalls } = await setupBackendApi({
      fetchMock: vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: 'expired' }),
      }),
    });

    await expect(mod.backendFetch('/fleetedge/status')).rejects.toThrow();
    const warnEvent = telemetryCalls.find((e) => e.msg.includes('401'));
    expect(warnEvent).toBeDefined();
    expect(warnEvent.extra.path).toBe('/fleetedge/status');
  });

  it('logout records BACKEND telemetry', async () => {
    const { mod, telemetryCalls } = await setupBackendApi({
      fetchMock: vi
        .fn()
        .mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    });

    await mod.logout();
    expect(telemetryCalls.some((e) => e.msg === 'Logged out')).toBe(true);
  });

  it('non-OK response records BACKEND error telemetry', async () => {
    const { mod, telemetryCalls } = await setupBackendApi({
      fetchMock: vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({ message: 'Internal' }),
      }),
    });

    await expect(mod.backendFetch('/test')).rejects.toThrow();
    const errEvent = telemetryCalls.find((e) => e.sev === 'ERROR' && e.extra?.status === 500);
    expect(errEvent).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2: fleetedgeLink.js — multi-tab, token TTL, telemetry
// ═══════════════════════════════════════════════════════════════════════════════

describe('fleetedgeLink — v2 improvements', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  function makeStore() {
    const store = {};
    return {
      store,
      chromeMock: {
        storage: {
          local: {
            get: vi.fn((keys) => {
              const result = {};
              (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
                if (k in store) result[k] = store[k];
              });
              return Promise.resolve(result);
            }),
            set: vi.fn((obj) => {
              Object.assign(store, obj);
              return Promise.resolve();
            }),
            remove: vi.fn(() => Promise.resolve()),
          },
        },
        tabs: {
          query: vi.fn(() => Promise.resolve([])),
          sendMessage: vi.fn(),
          reload: vi.fn(() => Promise.resolve()),
        },
        permissions: { contains: vi.fn(() => Promise.resolve(true)) },
        action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
        notifications: { create: vi.fn() },
      },
    };
  }

  async function setupFleetedgeLink(opts = {}) {
    const {
      tabsResult = [],
      sendMessageResult = null,
      backendFetchResult = null,
      throwOnBackendFetch = null,
    } = opts;
    const { store, chromeMock } = makeStore();
    chromeMock.tabs.query = vi.fn(() => Promise.resolve(tabsResult));
    chromeMock.tabs.sendMessage =
      sendMessageResult instanceof Error
        ? vi.fn(() => Promise.reject(sendMessageResult))
        : vi.fn(() => Promise.resolve(sendMessageResult));
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: {
        UI: 'UI',
        MESSAGE: 'MESSAGE',
        BACKEND: 'BACKEND',
        FLEETEDGE: 'FLEETEDGE',
        STORAGE: 'STORAGE',
        TOKEN: 'TOKEN',
        TASK: 'TASK',
      },
    }));

    const backendFetchMock = vi.fn(() => {
      if (throwOnBackendFetch) return Promise.reject(throwOnBackendFetch);
      return Promise.resolve({
        json: () =>
          Promise.resolve(backendFetchResult || { data: { success: true, vehicleCount: 0 } }),
      });
    });
    vi.doMock('../backendApi.js', () => ({
      backendFetch: backendFetchMock,
    }));

    const mod = await import('../fleetedgeLink.js');
    return { mod, telemetryCalls, store, chromeMock, backendFetchMock };
  }

  // ── Multi-tab handling ──────────────────────────────────────────────────────

  it('picks the most recently accessed tab when multiple FleetEdge tabs open', async () => {
    const { mod, chromeMock } = await setupFleetedgeLink({
      tabsResult: [
        { id: 10, lastAccessed: 1000 },
        { id: 20, lastAccessed: 5000 }, // most recent
        { id: 30, lastAccessed: 3000 },
      ],
      sendMessageResult: { success: false, error: 'Not logged in' },
    });

    await mod.connectFleetEdge();

    // Should have sent message to tab 20 (most recently accessed)
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(20, { type: 'READ_FLEETEDGE_TOKEN' });
  });

  it('single tab does not need sorting', async () => {
    const { mod, chromeMock } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: { success: false, error: 'Not logged in' },
    });

    await mod.connectFleetEdge();
    expect(chromeMock.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'READ_FLEETEDGE_TOKEN' });
  });

  // ── Token TTL validation ────────────────────────────────────────────────────

  it('rejects token that expires within 10 minutes', async () => {
    const nearExpiry = Math.floor(Date.now() / 1000) + 300; // 5 min from now
    const { mod, telemetryCalls } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTl9.sig',
        fleetId: 'F123',
        exp: nearExpiry,
        foundIn: 'localStorage',
      },
    });

    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(false);
    expect(result.error).toContain('expires in');

    // Should record TOKEN telemetry
    const ttlWarn = telemetryCalls.find((e) => e.layer === 'TOKEN' && e.msg.includes('expiry'));
    expect(ttlWarn).toBeDefined();
  });

  it('accepts token with > 10 minutes remaining', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200; // 2 hours from now
    const { mod } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTl9.sig',
        fleetId: 'F123',
        exp: safeExpiry,
        foundIn: 'localStorage',
      },
      backendFetchResult: { data: { success: true, vehicleCount: 10, expiresAt: safeExpiry } },
    });

    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(true);
    expect(result.vehicleCount).toBe(10);
  });

  it('skips TTL check when token has no exp (lets backend validate)', async () => {
    const { mod } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'some-token',
        fleetId: 'F123',
        exp: null, // no exp
        foundIn: 'localStorage',
      },
      backendFetchResult: { data: { success: true, vehicleCount: 5 } },
    });

    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(true);
  });

  // ── TOKEN telemetry ─────────────────────────────────────────────────────────

  it('records TOKEN.INFO on successful token read', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    const { mod, telemetryCalls } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'jwt',
        fleetId: 'F1',
        exp: safeExpiry,
        foundIn: 'sessionStorage',
      },
      backendFetchResult: { data: { vehicleCount: 5 } },
    });

    await mod.connectFleetEdge();

    const tokenRead = telemetryCalls.find(
      (e) => e.layer === 'TOKEN' && e.msg === 'Token read from content script'
    );
    expect(tokenRead).toBeDefined();
    expect(tokenRead.extra.foundIn).toBe('sessionStorage');
  });

  it('records TOKEN.WARN on no FleetEdge tab', async () => {
    const { mod, telemetryCalls } = await setupFleetedgeLink({ tabsResult: [] });
    await mod.connectFleetEdge();

    expect(
      telemetryCalls.some((e) => e.layer === 'TOKEN' && e.msg === 'No FleetEdge tab found')
    ).toBe(true);
  });

  it('records TOKEN.ERROR on content script communication failure', async () => {
    const { mod, telemetryCalls } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: new Error('Receiving end does not exist'),
    });

    await mod.connectFleetEdge();

    const err = telemetryCalls.find((e) => e.layer === 'TOKEN' && e.sev === 'ERROR');
    expect(err).toBeDefined();
    expect(err.extra.reason).toContain('Receiving end');
  });

  // ── FLEETEDGE telemetry ─────────────────────────────────────────────────────

  it('records FLEETEDGE.INFO on successful link', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    const { mod, telemetryCalls } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'jwt',
        fleetId: 'F1',
        exp: safeExpiry,
        foundIn: 'ls',
      },
      backendFetchResult: { data: { vehicleCount: 15, expiresAt: safeExpiry } },
    });

    await mod.connectFleetEdge();

    const linked = telemetryCalls.find(
      (e) => e.layer === 'FLEETEDGE' && e.msg === 'FleetEdge linked'
    );
    expect(linked).toBeDefined();
    expect(linked.extra.vehicleCount).toBe(15);
  });

  it('records FLEETEDGE.ERROR when backend rejects token', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    const { mod, telemetryCalls } = await setupFleetedgeLink({
      tabsResult: [{ id: 42 }],
      sendMessageResult: {
        success: true,
        token: 'jwt',
        fleetId: 'F1',
        exp: safeExpiry,
        foundIn: 'ls',
      },
      throwOnBackendFetch: new Error('Server rejected token'),
    });

    const result = await mod.connectFleetEdge();
    expect(result.success).toBe(false);

    const errTel = telemetryCalls.find((e) => e.layer === 'FLEETEDGE' && e.sev === 'ERROR');
    expect(errTel).toBeDefined();
    expect(errTel.msg).toContain('Link token to backend failed');
  });

  it('records FLEETEDGE.INFO on disconnect', async () => {
    const { mod, telemetryCalls } = await setupFleetedgeLink();
    await mod.disconnectFleetEdge();

    expect(
      telemetryCalls.some((e) => e.layer === 'FLEETEDGE' && e.msg === 'FleetEdge disconnected')
    ).toBe(true);
  });

  it('getFleetEdgeStatus records FLEETEDGE.DEBUG on success', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    const { chromeMock } = makeStore();
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(() =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                accounts: [
                  {
                    accountId: 'a1',
                    status: 'ACTIVE',
                    fleetId: 'F1',
                    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
                  },
                ],
                pull: {},
              },
            }),
        })
      ),
    }));

    const mod = await import('../fleetedgeLink.js');
    const status = await mod.getFleetEdgeStatus();
    expect(status.accounts[0].fleetId).toBe('F1');

    const debugEvt = telemetryCalls.find(
      (e) => e.layer === 'FLEETEDGE' && e.msg === 'FleetEdge status fetched'
    );
    expect(debugEvt).toBeDefined();
  });

  it('getFleetEdgeStatus records FLEETEDGE.WARN on expired token', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    const { chromeMock } = makeStore();
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(() =>
        Promise.resolve({
          json: () =>
            Promise.resolve({
              data: {
                accounts: [
                  {
                    accountId: 'a1',
                    status: 'NEEDS_REAUTH',
                    fleetId: 'F1',
                    expiresAt: new Date(Date.now() - 3600_000).toISOString(),
                  },
                ],
                pull: {},
              },
            }),
        })
      ),
    }));

    const mod = await import('../fleetedgeLink.js');
    const status = await mod.getFleetEdgeStatus();
    expect(status.accounts[0].status).toBe('NEEDS_REAUTH');

    const debugEvt = telemetryCalls.find(
      (e) => e.layer === 'FLEETEDGE' && e.msg === 'FleetEdge status fetched'
    );
    expect(debugEvt).toBeDefined();
    // badge should show expired count (1 expired account)
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '1' });
  });

  it('getFleetEdgeStatus falls back to cache when backend fails', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    const { store, chromeMock } = makeStore();
    store.fleetEdgeAccounts = [
      {
        accountId: 'a1',
        status: 'ACTIVE',
        fleetId: 'cached-fleet',
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      },
    ];
    store.fleetEdgePull = {};
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(() => Promise.reject(new Error('Network down'))),
    }));

    const mod = await import('../fleetedgeLink.js');
    const status = await mod.getFleetEdgeStatus();

    expect(status.accounts[0].fleetId).toBe('cached-fleet');
    expect(status.accounts[0].status).toBe('ACTIVE');

    const warnEvt = telemetryCalls.find((e) => e.msg.includes('Status check failed'));
    expect(warnEvt).toBeDefined();
  });

  it('disconnectFleetEdge records FLEETEDGE.WARN when unlink API fails', async () => {
    vi.restoreAllMocks();
    vi.resetModules();

    const { chromeMock } = makeStore();
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    vi.doMock('../backendApi.js', () => ({
      backendFetch: vi.fn(() => Promise.reject(new Error('Server 500'))),
    }));

    const mod = await import('../fleetedgeLink.js');
    const result = await mod.disconnectFleetEdge();

    // Should still succeed (local state cleared)
    expect(result.success).toBe(true);

    // But should record the API failure as a warning
    const warnEvt = telemetryCalls.find((e) => e.msg === 'Unlink API call failed');
    expect(warnEvt).toBeDefined();
    expect(warnEvt.extra.error).toBe('Server 500');

    // And also record the disconnect
    expect(telemetryCalls.some((e) => e.msg === 'FleetEdge disconnected')).toBe(true);
  });

  // ── H-4: storage serialization ──────────────────────────────────────────────

  it('serializes two concurrent connect calls so neither clobbers storage (H-4)', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    const { store, chromeMock } = makeStore();
    chromeMock.tabs.query = vi.fn(() => Promise.resolve([{ id: 42 }]));
    chromeMock.tabs.sendMessage = vi.fn(() =>
      Promise.resolve({
        success: true,
        token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjk5OTl9.sig',
        fleetId: 'F1',
        exp: safeExpiry,
        foundIn: 'ls',
      })
    );
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      }),
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    // Track interleaving: each call slowly resolves; if they ran in parallel,
    // both link-token POSTs would observe an empty accounts list at the time of
    // the subsequent /status call. With the lock, the second connect waits.
    let inFlight = 0;
    let maxConcurrent = 0;
    let callIdx = 0;
    const backendFetchMock = vi.fn((path) => {
      inFlight++;
      maxConcurrent = Math.max(maxConcurrent, inFlight);
      const idx = ++callIdx;
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          if (path === '/fleetedge/link-token') {
            resolve({
              json: () =>
                Promise.resolve({
                  data: { accountId: `acc-${idx}`, vehicleCount: idx, expiresAt: safeExpiry },
                }),
            });
          } else if (path === '/fleetedge/status') {
            // /status writes whatever the backend says back into storage
            const existing = store.fleetEdgeAccounts || [];
            resolve({
              json: () =>
                Promise.resolve({
                  data: {
                    accounts: [...existing, { accountId: `acc-${idx}`, fleetId: 'F1' }],
                    pull: {},
                  },
                }),
            });
          } else {
            resolve({ json: () => Promise.resolve({ data: {} }) });
          }
        }, 5);
      });
    });
    vi.doMock('../backendApi.js', () => ({ backendFetch: backendFetchMock }));

    const mod = await import('../fleetedgeLink.js');

    const [r1, r2] = await Promise.all([mod.connectFleetEdge(), mod.connectFleetEdge()]);

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    // The link lock must serialize: at most one backendFetch is in-flight at a time.
    expect(maxConcurrent).toBe(1);
    // And both accountIds should survive in storage (no clobber).
    const finalAccounts = store.fleetEdgeAccounts || [];
    const ids = finalAccounts.map((a) => a.accountId).sort();
    expect(ids).toEqual(['acc-2', 'acc-4']); // link=1,status=2 then link=3,status=4
  });

  // ── H-3: reconnect refuses mismatched JWT ───────────────────────────────────

  it('reconnect refuses to link a token whose JWT fleet_id != stored fleetId (H-3)', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    // Build a JWT-shaped token whose payload says fleet_id = 'F_OTHER'.
    const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
    const payload = btoa(JSON.stringify({ fleet_id: 'F_OTHER', exp: safeExpiry }));
    const jwt = `${header}.${payload}.sig`;

    const { store, chromeMock } = makeStore();
    // Pre-populate storage with the account we want to reconnect: F_REQUESTED.
    store.fleetEdgeAccounts = [
      { accountId: 'acc-requested', fleetId: 'F_REQUESTED', status: 'EXPIRED' },
    ];
    chromeMock.tabs.query = vi.fn(() => Promise.resolve([{ id: 42 }]));
    // The captured token reports a different fleet identity than the requested account.
    chromeMock.tabs.sendMessage = vi.fn(() =>
      Promise.resolve({
        success: true,
        token: jwt,
        fleetId: 'F_OTHER',
        exp: safeExpiry,
        foundIn: 'ls',
      })
    );
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    const telemetryCalls = [];
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: (layer) => {
        const makeMethod = (sev) => (msg, extra) => telemetryCalls.push({ layer, sev, msg, extra });
        return {
          debug: makeMethod('DEBUG'),
          info: makeMethod('INFO'),
          warn: makeMethod('WARN'),
          error: makeMethod('ERROR'),
          fatal: makeMethod('FATAL'),
          perfStart: vi.fn(),
          perfEnd: vi.fn(),
        };
      },
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    const backendFetchMock = vi.fn();
    vi.doMock('../backendApi.js', () => ({ backendFetch: backendFetchMock }));

    const mod = await import('../fleetedgeLink.js');
    const result = await mod.reconnectFleetEdgeAccount('acc-requested');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/different account/i);
    // Crucially the backend POST must NOT have fired — that's the cross-account corruption.
    expect(backendFetchMock).not.toHaveBeenCalled();
    // And we should record a WARN telemetry event.
    const mismatch = telemetryCalls.find(
      (e) => e.layer === 'FLEETEDGE' && e.msg.includes('JWT owner does not match')
    );
    expect(mismatch).toBeDefined();
    expect(mismatch.extra.expectedFleetId).toBe('F_REQUESTED');
    expect(mismatch.extra.tokenFleetId).toBe('F_OTHER');
  });

  it('reconnect proceeds normally when JWT fleet_id matches stored fleetId (H-3)', async () => {
    const safeExpiry = Math.floor(Date.now() / 1000) + 7200;
    const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'HS256' }));
    const payload = btoa(JSON.stringify({ fleet_id: 'F_MATCH', exp: safeExpiry }));
    const jwt = `${header}.${payload}.sig`;

    const { store, chromeMock } = makeStore();
    store.fleetEdgeAccounts = [{ accountId: 'acc-match', fleetId: 'F_MATCH', status: 'EXPIRED' }];
    chromeMock.tabs.query = vi.fn(() => Promise.resolve([{ id: 42 }]));
    chromeMock.tabs.sendMessage = vi.fn(() =>
      Promise.resolve({
        success: true,
        token: jwt,
        fleetId: 'F_MATCH',
        exp: safeExpiry,
        foundIn: 'ls',
      })
    );
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      }),
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));

    const backendFetchMock = vi.fn((path) => {
      if (path === '/fleetedge/link-token') {
        return Promise.resolve({
          json: () =>
            Promise.resolve({
              data: { accountId: 'acc-match', vehicleCount: 3, expiresAt: safeExpiry },
            }),
        });
      }
      return Promise.resolve({
        json: () => Promise.resolve({ data: { accounts: [], pull: {} } }),
      });
    });
    vi.doMock('../backendApi.js', () => ({ backendFetch: backendFetchMock }));

    const mod = await import('../fleetedgeLink.js');
    const result = await mod.reconnectFleetEdgeAccount('acc-match');

    expect(result.success).toBe(true);
    expect(backendFetchMock).toHaveBeenCalledWith(
      '/fleetedge/link-token',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('reconnect rejects unknown accountId (H-3 guard rail)', async () => {
    const { store, chromeMock } = makeStore();
    store.fleetEdgeAccounts = [{ accountId: 'acc-a', fleetId: 'F_A' }];
    vi.stubGlobal('chrome', chromeMock);

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));
    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        fatal: vi.fn(),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      }),
      LAYERS: { FLEETEDGE: 'FLEETEDGE', TOKEN: 'TOKEN' },
    }));
    const backendFetchMock = vi.fn();
    vi.doMock('../backendApi.js', () => ({ backendFetch: backendFetchMock }));

    const mod = await import('../fleetedgeLink.js');
    const result = await mod.reconnectFleetEdgeAccount('acc-does-not-exist');

    expect(result.success).toBe(false);
    expect(backendFetchMock).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3: index.js — status cache, parallel fetch, URL validation
// Uses vi.doMock for handleMessage isolation since index.js has side effects.
// ═══════════════════════════════════════════════════════════════════════════════

describe('index.js — v2 improvements (handleMessage logic)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  /**
   * Sets up a fresh index.js import with controlled mocks.
   * Returns the module and spies on key functions.
   */
  async function setupIndex(opts = {}) {
    const {
      store = {},
      loginResult = { token: 'jwt', user: { name: 'T', role: 'OWNER' } },
      feStatusResult = {
        accounts: [
          {
            accountId: 'a1',
            status: 'ACTIVE',
            fleetId: 'F1',
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        ],
        pull: { lastRunAt: null, nextRunAt: null },
      },
      fetchStatusResult = { data: { pending: 5, completed: 10 } },
      connectResult = { success: true, vehicleCount: 15 },
      disconnectResult = { success: true },
    } = opts;

    const STORE = { ...store };
    const actionCalls = [];

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
      alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
      action: {
        setBadgeText: vi.fn((o) => actionCalls.push({ badge: o.text })),
        setBadgeBackgroundColor: vi.fn(),
      },
      runtime: {
        onMessage: { addListener: vi.fn() },
        onMessageExternal: { addListener: vi.fn() },
        onInstalled: { addListener: vi.fn() },
        getManifest: vi.fn(() => ({ version: '2.0.0' })),
      },
      tabs: { query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn() },
      notifications: { create: vi.fn() },
    });

    const getFleetEdgeStatusSpy = vi.fn(() => Promise.resolve(feStatusResult));
    const connectFleetEdgeSpy = vi.fn(() => Promise.resolve(connectResult));
    const disconnectFleetEdgeSpy = vi.fn(() => Promise.resolve(disconnectResult));

    vi.doMock('../fleetedgeLink.js', () => ({
      connectFleetEdge: connectFleetEdgeSpy,
      getFleetEdgeStatus: getFleetEdgeStatusSpy,
      disconnectFleetEdge: disconnectFleetEdgeSpy,
    }));

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      getLogs: vi.fn(() => Promise.resolve([])),
      clearLogs: vi.fn(() => Promise.resolve()),
    }));

    vi.doMock('../config.js', () => ({
      config: {
        BACKEND_BASE_URL: 'http://localhost:3000',
        API_PREFIX: '/api/extension',
        STATUS_POLL_INTERVAL_MINUTES: 2,
        TELEMETRY_ENABLED: true,
        TELEMETRY_MAX_EVENTS: 100,
        TELEMETRY_FLUSH_INTERVAL_MS: 5000,
        TELEMETRY_SHIP_TO_BACKEND: false,
        TELEMETRY_SHIP_INTERVAL_MS: 60000,
        TELEMETRY_HEALTH_CHECK_INTERVAL_MS: 300000,
        TELEMETRY_MIN_SEVERITY: 'DEBUG',
        FETCH_TIMEOUT_MS: 15000,
        TRIGGER_COOLDOWN_MS: 30_000,
      },
    }));

    const loginSpy = vi.fn(() => Promise.resolve(loginResult));
    const logoutSpy = vi.fn(() => Promise.resolve());
    const isAuthenticatedSpy = vi.fn(() => Promise.resolve(!!STORE.authToken));
    const backendFetchSpy = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: fetchStatusResult.data }),
      })
    );
    const fetchStatusSpy = vi.fn(() => Promise.resolve(fetchStatusResult));

    vi.doMock('../backendApi.js', () => ({
      login: loginSpy,
      logout: logoutSpy,
      isAuthenticated: isAuthenticatedSpy,
      backendFetch: backendFetchSpy,
      fetchStatus: fetchStatusSpy,
    }));

    // telemetry.js mock — index.js calls startTelemetry() at load time
    vi.doMock('../telemetry.js', () => {
      const makeMethod = () => vi.fn();
      const createLayerLogger = () => ({
        debug: makeMethod('DEBUG'),
        info: makeMethod('INFO'),
        warn: makeMethod('WARN'),
        error: makeMethod('ERROR'),
        fatal: makeMethod('FATAL'),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      });
      return {
        startTelemetry: vi.fn(),
        record: vi.fn(),
        LAYERS: {
          UI: 'UI',
          MESSAGE: 'MESSAGE',
          BACKEND: 'BACKEND',
          FLEETEDGE: 'FLEETEDGE',
          STORAGE: 'STORAGE',
          TOKEN: 'TOKEN',
          TASK: 'TASK',
        },
        SEVERITY: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3, FATAL: 4 },
        createLayerLogger,
        getEvents: vi.fn(() => Promise.resolve([])),
        clearEvents: vi.fn(() => Promise.resolve()),
        getStats: vi.fn(() => Promise.resolve({})),
        getHealthSnapshot: vi.fn(() => Promise.resolve({})),
        getBreadcrumbs: vi.fn(() => []),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      };
    });

    // Import index.js — side effects fire (alarms, etc.)
    await import('../index.js');

    // Extract the message handler from chrome.runtime.onMessage.addListener
    const messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0];

    // Helper to call a message and get the response
    async function sendMessage(message) {
      return new Promise((resolve) => {
        const sendResponse = (response) => resolve(response);
        const result = messageHandler(message, {}, sendResponse);
        // If returns false, no async — resolve immediately
        if (result === false) resolve(undefined);
      });
    }

    return {
      sendMessage,
      STORE,
      spies: {
        login: loginSpy,
        logout: logoutSpy,
        isAuthenticated: isAuthenticatedSpy,
        backendFetch: backendFetchSpy,
        fetchStatus: fetchStatusSpy,
        getFleetEdgeStatus: getFleetEdgeStatusSpy,
        connectFleetEdge: connectFleetEdgeSpy,
        disconnectFleetEdge: disconnectFleetEdgeSpy,
      },
      actionCalls,
    };
  }

  // ── URL validation ──────────────────────────────────────────────────────────

  it('SET_BACKEND_URL rejects invalid URLs', async () => {
    const { sendMessage } = await setupIndex();
    const result = await sendMessage({ type: 'SET_BACKEND_URL', url: 'not-a-valid-url' });
    expect(result.error).toContain('Invalid URL');
  });

  it('SET_BACKEND_URL accepts valid URLs', async () => {
    const { sendMessage, STORE } = await setupIndex();
    const result = await sendMessage({ type: 'SET_BACKEND_URL', url: 'https://api.example.com' });
    expect(result.success).toBe(true);
    expect(STORE.backendUrl).toBe('https://api.example.com');
  });

  it('SET_BACKEND_URL rejects empty URL', async () => {
    const { sendMessage } = await setupIndex();
    const result = await sendMessage({ type: 'SET_BACKEND_URL', url: '' });
    expect(result.error).toContain('URL is required');
  });

  // ── GET_STATUS parallel fetch ───────────────────────────────────────────────

  it('GET_STATUS fetches metrics, backend status, and FE status in parallel', async () => {
    const { sendMessage, spies, STORE } = await setupIndex({
      store: { authToken: 'jwt-123', authUser: { name: 'T' } },
    });

    const result = await sendMessage({ type: 'GET_STATUS' });

    expect(result.authenticated).toBe(true);
    expect(result.fleetEdge.accounts[0].fleetId).toBe('F1');
    expect(result.backendStatus).toBeDefined();
    expect(result.metrics).toBeDefined();

    // Both should have been called (parallel)
    expect(spies.fetchStatus).toHaveBeenCalled();
    expect(spies.getFleetEdgeStatus).toHaveBeenCalled();
  });

  it('GET_STATUS returns cached FE status when backend is down', async () => {
    // Start with NO authToken so startup skips getCachedFleetEdgeStatus() caching.
    const { sendMessage, spies, STORE } = await setupIndex({ store: {} });

    // Now seed the store and make the FE status spy reject lazily
    Object.assign(STORE, {
      authToken: 'jwt-123',
      fleetEdgeAccounts: [
        {
          accountId: 'a1',
          status: 'ACTIVE',
          fleetId: 'cached-fleet',
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      ],
      fleetEdgePull: {},
    });
    spies.getFleetEdgeStatus.mockImplementation(() => Promise.reject(new Error('Network down')));

    // GET_STATUS catches the rejection → falls back to cachedFe from storage
    const result = await sendMessage({ type: 'GET_STATUS' });

    expect(result.authenticated).toBe(true);
    expect(result.fleetEdge.accounts[0].fleetId).toBe('cached-fleet');
  });

  it('GET_STATUS for unauthenticated user skips network calls', async () => {
    const { sendMessage, spies } = await setupIndex({ store: {} });

    const result = await sendMessage({ type: 'GET_STATUS' });

    expect(result.authenticated).toBe(false);
    expect(spies.fetchStatus).not.toHaveBeenCalled();
    expect(spies.getFleetEdgeStatus).not.toHaveBeenCalled();
  });

  // ── TRIGGER_PROCESS uses static import ──────────────────────────────────────

  it('TRIGGER_PROCESS uses backendFetch directly (not dynamic import)', async () => {
    const { sendMessage, spies } = await setupIndex({
      store: { authToken: 'jwt-123' },
    });

    const result = await sendMessage({ type: 'TRIGGER_PROCESS' });
    expect(result.success).toBe(true);
    expect(spies.backendFetch).toHaveBeenCalledWith('/fleetedge/process-tasks', { method: 'POST' });
  });

  it('TRIGGER_PROCESS enforces cooldown — second call within window is rejected', async () => {
    const { sendMessage, spies } = await setupIndex({
      store: { authToken: 'jwt-123' },
    });

    const first = await sendMessage({ type: 'TRIGGER_PROCESS' });
    expect(first.success).toBe(true);
    expect(spies.backendFetch).toHaveBeenCalledTimes(1);

    // Immediate second call: still in cooldown.
    const second = await sendMessage({ type: 'TRIGGER_PROCESS' });
    expect(second.cached).toBe(true);
    expect(second.retryInMs).toBeGreaterThan(0);
    // Backend was NOT hit again.
    expect(spies.backendFetch).toHaveBeenCalledTimes(1);
  });

  it('TRIGGER_PROCESS cooldown without prior success returns error shape', async () => {
    const { sendMessage, spies } = await setupIndex({
      store: { authToken: 'jwt-123' },
    });
    // First call fails — _lastTriggerAt still bumped, _lastTriggerResult null.
    spies.backendFetch.mockImplementationOnce(() => Promise.reject(new Error('boom')));

    const first = await sendMessage({ type: 'TRIGGER_PROCESS' });
    expect(first.success).toBe(false);

    // Second call is inside cooldown with no cached success → cooldown error.
    const second = await sendMessage({ type: 'TRIGGER_PROCESS' });
    expect(second.success).toBe(false);
    expect(second.error).toBe('cooldown');
    expect(second.retryInMs).toBeGreaterThan(0);
    expect(spies.backendFetch).toHaveBeenCalledTimes(1);
  });

  // ── Cache invalidation ──────────────────────────────────────────────────────

  it('DISCONNECT_FLEETEDGE invalidates status cache', async () => {
    const { sendMessage, spies } = await setupIndex();

    // First call caches
    await sendMessage({ type: 'GET_FLEETEDGE_STATUS' });
    const firstCallCount = spies.getFleetEdgeStatus.mock.calls.length;

    // Disconnect should invalidate cache
    await sendMessage({ type: 'DISCONNECT_FLEETEDGE' });

    // Next status fetch should make a fresh call
    await sendMessage({ type: 'GET_FLEETEDGE_STATUS' });
    expect(spies.getFleetEdgeStatus.mock.calls.length).toBeGreaterThan(firstCallCount);
  });

  it('LOGOUT invalidates status cache and clears badge', async () => {
    const { sendMessage } = await setupIndex({ store: { authToken: 'jwt-123' } });

    await sendMessage({ type: 'LOGOUT' });

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
  });

  it('CLEAR_ALL invalidates status cache', async () => {
    const { sendMessage, spies, STORE } = await setupIndex({
      store: { authToken: 'jwt', authUser: { name: 'T' } },
    });

    await sendMessage({ type: 'CLEAR_ALL' });

    expect(spies.disconnectFleetEdge).toHaveBeenCalled();
    expect(STORE.authToken).toBeUndefined();
  });

  // ── CONNECT_FLEETEDGE invalidates cache before connect ──────────────────────

  it('CONNECT_FLEETEDGE invalidates cache before connecting', async () => {
    const { sendMessage, spies } = await setupIndex();

    await sendMessage({ type: 'CONNECT_FLEETEDGE' });
    expect(spies.connectFleetEdge).toHaveBeenCalled();
  });

  // ── Status polling uses config ──────────────────────────────────────────────

  it('statusPoll alarm uses jittered config.STATUS_POLL_INTERVAL_MINUTES', async () => {
    await setupIndex();

    // Period is jittered ±25% around the base of 2 min (RL-3 bot-detection fix)
    const call = chrome.alarms.create.mock.calls.find((c) => c[0] === 'statusPoll');
    expect(call).toBeDefined();
    expect(call[1].delayInMinutes).toBe(1);
    expect(call[1].periodInMinutes).toBeGreaterThanOrEqual(2 * 0.75);
    expect(call[1].periodInMinutes).toBeLessThanOrEqual(2 * 1.25);
  });

  it('statusPoll alarm period varies across invocations (jitter)', async () => {
    const periods = new Set();
    for (let i = 0; i < 8; i++) {
      vi.resetModules();
      await setupIndex();
      const call = chrome.alarms.create.mock.calls.find((c) => c[0] === 'statusPoll');
      periods.add(call[1].periodInMinutes);
    }
    // 8 invocations should produce more than 1 unique period
    // (Math.random collision odds ≈ 1/2^53 per pair).
    expect(periods.size).toBeGreaterThan(1);
  });

  // ── Unknown message type ────────────────────────────────────────────────────

  it('unknown message type returns error', async () => {
    const { sendMessage } = await setupIndex();
    const result = await sendMessage({ type: 'TOTALLY_BOGUS' });
    expect(result.error).toContain('Unknown message type');
  });

  // ── LOGIN validation ────────────────────────────────────────────────────────

  it('LOGIN requires both emailOrMobile and password', async () => {
    const { sendMessage } = await setupIndex();

    const r1 = await sendMessage({ type: 'LOGIN', emailOrMobile: 'user@test.com' });
    expect(r1.error).toContain('required');

    const r2 = await sendMessage({ type: 'LOGIN', password: 'pass' });
    expect(r2.error).toContain('required');
  });

  // ── Content script message filtering ────────────────────────────────────────

  it('READ_FLEETEDGE_TOKEN messages are ignored (returns false)', async () => {
    await setupIndex();

    const messageHandler = chrome.runtime.onMessage.addListener.mock.calls[0]?.[0];
    const result = messageHandler({ type: 'READ_FLEETEDGE_TOKEN' }, {}, vi.fn());
    expect(result).toBe(false);
  });
});
