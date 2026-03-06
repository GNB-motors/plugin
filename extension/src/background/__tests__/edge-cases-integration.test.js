/**
 * FleetEdge Plugin - Integration Edge Cases & Error Boundaries
 * Tests that need MOCKED module dependencies (backendApi, fleetedgeApi, taskPoller).
 *
 * IMPORTANT: Each describe block uses vi.doMock() (not hoisted) and
 * vi.resetModules() for proper test isolation.
 *
 * DO NOT SKIP THESE TESTS.
 *     timedFetch timeout -> extension hangs forever waiting for backend.
 *     401 clear-auth path -> user stuck in infinite re-login loop.
 *     VIN last-4 fallback -> tasks fail for vehicles with non-standard registrations.
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
    await expect(mod.fetchPendingTasks()).rejects.toThrow('timed out');
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
    await expect(mod.fetchPendingTasks()).rejects.toThrow();
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
});

// SECTION 2: fleetedgeApi.js Edge Cases
describe('fleetedgeApi - edge cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupFleetedgeApi(chromeOverrides = {}) {
    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: { CVP_API_BASE: 'https://cvp.api.tatamotors' },
    }));
    vi.doMock('../utils.js', () => ({
      withRetry: vi.fn((fn) => fn()),
    }));
    vi.stubGlobal('chrome', {
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript: vi.fn().mockResolvedValue([{}]) },
      storage: { local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn() } },
      ...chromeOverrides,
    });
    return import('../fleetedgeApi.js');
  }

  it('multiple FleetEdge tabs: uses first tab', async () => {
    const mod = await setupFleetedgeApi({
      tabs: { query: vi.fn().mockResolvedValue([{ id: 10 }, { id: 20 }, { id: 30 }]) },
      scripting: {
        executeScript: vi.fn().mockResolvedValue([{
          result: { ok: true, status: 200, text: JSON.stringify({ result: [] }) },
        }]),
      },
    });
    await mod.fetchVehicles('token', 'fleet-1');
    const scriptCalls = chrome.scripting.executeScript.mock.calls;
    expect(scriptCalls[0][0].target.tabId).toBe(10);
  });

  it('executeScript returning null result throws ApiError', async () => {
    const mod = await setupFleetedgeApi({
      tabs: { query: vi.fn().mockResolvedValue([{ id: 42 }]) },
      scripting: { executeScript: vi.fn().mockResolvedValue([{ result: null }]) },
    });
    await expect(mod.fetchVehicles('token', 'fleet-1')).rejects.toThrow('no result');
  });
});

// SECTION 3: taskPoller.js Edge Cases
describe('taskPoller - edge cases', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function setupTaskPoller(opts = {}) {
    const { tasks = [], vinMap = {}, fuelResults = [] } = opts;
    const STORE = { vinMap, vinMapUpdatedAt: Date.now() };

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
      alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
      notifications: { create: vi.fn() },
    });

    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    vi.doMock('../config.js', () => ({
      config: {
        POLL_INTERVAL_MINUTES: 5, INTER_TASK_DELAY_MS: 0,
        VIN_CACHE_TTL_HOURS: 24, MAX_RETRY_ATTEMPTS: 3,
        SEARCH_WINDOW_MINUTES: 30, TOKEN_EXPIRY_BUFFER_SECONDS: 60,
        BACKEND_BASE_URL: 'http://localhost:3000',
        API_PREFIX: '/api/extension',
        CVP_API_BASE: 'https://cvp.api.tatamotors',
        FLEETEDGE_ORIGIN: 'https://fleetedge.home.tatamotors',
      },
    }));
    vi.doMock('../utils.js', async (importOriginal) => {
      const actual = await importOriginal();
      return { ...actual };
    });
    vi.doMock('../tokenCapture.js', () => ({
      getValidToken: vi.fn(() => Promise.resolve({
        valid: true, token: 'tok', fleetId: 'f1', remainingSeconds: 9999,
      })),
    }));

    const mockSubmitTaskResult = vi.fn(() => Promise.resolve({}));
    const mockReportTaskError = vi.fn(() => Promise.resolve());

    vi.doMock('../backendApi.js', () => ({
      isAuthenticated: vi.fn(() => Promise.resolve(true)),
      fetchPendingTasks: vi.fn(() => Promise.resolve(tasks)),
      submitTaskResult: mockSubmitTaskResult,
      reportTaskError: mockReportTaskError,
    }));
    vi.doMock('../fleetedgeApi.js', () => ({
      fetchVehicles: vi.fn(() => Promise.resolve([])),
      fetchFuelConsumption: vi.fn(() => Promise.resolve({ results: fuelResults })),
      ApiError: class ApiError extends Error {
        constructor(msg, status) { super(msg); this.name = 'ApiError'; this.status = status; }
      },
    }));

    const { triggerPollNow } = await import('../taskPoller.js');
    return { triggerPollNow, submitTaskResult: mockSubmitTaskResult, reportTaskError: mockReportTaskError };
  }

  it('VIN last-4 fallback matches when full registration does not', async () => {
    const { triggerPollNow, submitTaskResult, reportTaskError } = await setupTaskPoller({
      tasks: [{ id: 'task-fallback', vehicle_number: 'XX99Z9640', refuel_date: '2026-03-01', refuel_time: '12:00' }],
      vinMap: { WB25R9640: 'VIN-MATCH-001' },
      fuelResults: [{ fuel_used: 50 }],
    });
    await triggerPollNow();
    expect(submitTaskResult).toHaveBeenCalledWith(
      'task-fallback',
      expect.objectContaining({ totalFuelConsumed: 50 })
    );
    expect(reportTaskError).not.toHaveBeenCalled();
  });

  it('task with missing vehicle_number reports validation error', async () => {
    const { triggerPollNow, reportTaskError } = await setupTaskPoller({
      tasks: [{ id: 'task-no-vehicle', refuel_date: '2026-03-01', refuel_time: '12:00' }],
      vinMap: { A: 'B' },
    });
    await triggerPollNow();
    expect(reportTaskError).toHaveBeenCalledWith(
      'task-no-vehicle',
      expect.stringContaining('missing vehicle_number')
    );
  });

  it('fuel consumption with zero fuel_used still submits', async () => {
    const { triggerPollNow, submitTaskResult } = await setupTaskPoller({
      tasks: [{ id: 'task-zero-fuel', vehicle_number: 'WB25R9640', refuel_date: '2026-03-01', refuel_time: '12:00' }],
      vinMap: { WB25R9640: 'VIN1' },
      fuelResults: [{ fuel_used: 0 }],
    });
    await triggerPollNow();
    expect(submitTaskResult).toHaveBeenCalledWith(
      'task-zero-fuel',
      expect.objectContaining({ totalFuelConsumed: 0 })
    );
  });
});
