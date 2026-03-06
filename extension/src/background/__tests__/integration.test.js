/**
 * Integration tests — cross-module flows.
 *
 * Exercises real data flow across backendApi ↔ taskPoller ↔ utils ↔ logger
 * without mocking internal modules.  Only external boundaries
 * (chrome.storage, fetch, chrome.alarms/action/scripting) are stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub (shared real storage) ───────────────────────────────────────
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
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
  notifications: { create: vi.fn() },
  tabs: { query: vi.fn(() => Promise.resolve([])) },
  scripting: { executeScript: vi.fn() },
  webRequest: {
    onBeforeSendHeaders: { addListener: vi.fn() },
  },
});

vi.mock('../config.js', () => ({
  config: {
    BACKEND_BASE_URL: 'http://localhost:3000',
    API_PREFIX: '/api/extension',
    CVP_API_BASE: 'https://cvp.api.tatamotors',
    POLL_INTERVAL_MINUTES: 5,
    INTER_TASK_DELAY_MS: 0,
    VIN_CACHE_TTL_HOURS: 24,
    TOKEN_EXPIRY_BUFFER_SECONDS: 60,
    SEARCH_WINDOW_MINUTES: 30,
    LOG_RETENTION_COUNT: 100,
    MAX_RETRY_ATTEMPTS: 2,
  },
}));

// Import real (not mocked) modules — tests their interaction via shared storage
const { login, logout, isAuthenticated, fetchPendingTasks, submitTaskResult, reportTaskError } =
  await import('../backendApi.js');
const { triggerPollNow } = await import('../taskPoller.js');
const { getMetrics, updateMetrics } = await import('../utils.js');
const { getLogs, clearLogs } = await import('../logger.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function mockFetchSequence(responses) {
  let i = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    const r = responses[i] || responses[responses.length - 1];
    i++;
    return {
      ok: r.ok !== undefined ? r.ok : (r.status >= 200 && r.status < 300),
      status: r.status,
      json: () => Promise.resolve(r.body),
      text: () => Promise.resolve(JSON.stringify(r.body)),
    };
  }));
}

beforeEach(() => {
  Object.keys(STORE).forEach(k => delete STORE[k]);
  vi.clearAllMocks();
});

// ─── Flow 1: Login → auth check → fetch tasks → submit ──────────────────────

describe('Flow: login → fetchTasks → submitResult', () => {
  it('full authenticated round-trip', async () => {
    // 1. Login
    mockFetchSequence([
      { status: 200, body: { data: { token: 'jwt-int-1', user: { name: 'Tester', role: 'OWNER' } } } },
    ]);
    const res = await login('tester@org.com', 'secure');
    expect(res.token).toBe('jwt-int-1');
    expect(await isAuthenticated()).toBe(true);

    // 2. Fetch pending tasks
    mockFetchSequence([
      { status: 200, body: { data: { tasks: [
        { id: 'T1', vehicle_number: 'WB25R9640', from_date: '2026-01-01', from_time: '08:00', to_date: '2026-01-02', to_time: '18:00' },
      ] } } },
    ]);
    const tasks = await fetchPendingTasks();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe('T1');

    // 3. Submit result
    mockFetchSequence([
      { status: 200, body: { data: { consumption: { isFlagged: false } } } },
    ]);
    const submitRes = await submitTaskResult('T1', { totalFuelConsumed: 55.3, rawResponse: { results: [] } });
    expect(submitRes.data.consumption).toBeDefined();

    // 4. Verify fetch was called with correct body shape
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.fuel_consumed).toBe(55.3);
    expect(body.raw_response).toEqual({ results: [] });
  });

  it('uses stored backendUrl over config default', async () => {
    STORE.backendUrl = 'https://custom-api.example.com';
    STORE.authToken = 'jwt-custom';

    mockFetchSequence([
      { status: 200, body: { data: { tasks: [] } } },
    ]);
    await fetchPendingTasks();

    const [calledUrl] = vi.mocked(fetch).mock.calls[0];
    expect(calledUrl).toContain('custom-api.example.com');
  });
});

// ─── Flow 2: Auth lifecycle ──────────────────────────────────────────────────

describe('Flow: auth lifecycle', () => {
  it('login stores token, logout removes it, isAuthenticated reflects state', async () => {
    expect(await isAuthenticated()).toBe(false);

    mockFetchSequence([
      { status: 200, body: { data: { token: 'jwt-life', user: { name: 'U', role: 'MANAGER' } } } },
    ]);
    await login('u@org.com', 'p');
    expect(await isAuthenticated()).toBe(true);

    await logout();
    expect(await isAuthenticated()).toBe(false);
    expect(STORE.authToken).toBeUndefined();
    expect(STORE.authUser).toBeUndefined();
  });

  it('401 from backend auto-clears auth state', async () => {
    STORE.authToken = 'jwt-stale';

    mockFetchSequence([
      { status: 401, body: { message: 'jwt expired' } },
    ]);

    await expect(fetchPendingTasks()).rejects.toThrow();
    // Token should be cleared by the 401 handler
    expect(STORE.authToken).toBeUndefined();
  });

  it('login with wrong credentials throws and stays unauthenticated', async () => {
    mockFetchSequence([
      { status: 401, body: { message: 'Invalid credentials' } },
    ]);
    await expect(login('bad@test.com', 'wrong')).rejects.toThrow('Invalid credentials');
    expect(await isAuthenticated()).toBe(false);
  });
});

// ─── Flow 3: Poll cycle ─────────────────────────────────────────────────────

describe('Flow: triggerPollNow', () => {
  it('skips when backend auth is missing', async () => {
    STORE.fleetToken = 'ft';
    STORE.fleetId = 'f1';
    STORE.tokenExp = Math.floor(Date.now() / 1000) + 3600;

    mockFetchSequence([]);
    await triggerPollNow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('skips when FleetEdge token is missing', async () => {
    STORE.authToken = 'jwt-ok';

    mockFetchSequence([]);
    await triggerPollNow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('processes tasks end-to-end when both tokens are valid', async () => {
    // Set up both auth contexts
    STORE.authToken = 'jwt-ok';
    STORE.fleetToken = 'fleet-tok';
    STORE.fleetId = 'fleet-1';
    STORE.tokenExp = Math.floor(Date.now() / 1000) + 3600;
    STORE.vinMap = { WB25R9640: 'VIN001' };
    STORE.vinMapUpdatedAt = Date.now();

    // Backend: fetchPendingTasks then submitTaskResult
    mockFetchSequence([
      { status: 200, body: { data: { tasks: [
        { id: 'T2', vehicle_number: 'WB25R9640', from_date: '2026-02-01', from_time: '10:00', to_date: '2026-02-02', to_time: '18:00' }
      ] } } },
      { status: 200, body: { data: { consumption: {} } } },
    ]);

    // FleetEdge API (chrome.scripting.executeScript)
    chrome.scripting.executeScript.mockResolvedValue([{
      result: {
        ok: true,
        status: 200,
        text: JSON.stringify({ results: [{ vin: 'VIN001', fuel_used: 40.5 }] }),
      },
    }]);

    // Mock tabs.query to return a FleetEdge tab
    chrome.tabs.query.mockResolvedValue([{ id: 99 }]);

    await triggerPollNow();

    // Verify pending tasks fetch + result submission = 2 backend calls
    expect(fetch).toHaveBeenCalledTimes(2);

    // Verify submit body contains correct fuel data
    const submitCall = vi.mocked(fetch).mock.calls[1];
    const submitBody = JSON.parse(submitCall[1].body);
    expect(submitBody.fuel_consumed).toBe(40.5);
    expect(submitBody.raw_response).toBeDefined();
  });

  it('uses last-4-digit VIN fallback when exact match fails', async () => {
    STORE.authToken = 'jwt-ok';
    STORE.fleetToken = 'fleet-tok';
    STORE.fleetId = 'fleet-1';
    STORE.tokenExp = Math.floor(Date.now() / 1000) + 3600;
    // VIN map has full reg but task has slightly different format
    STORE.vinMap = { WB25R9640: 'VIN_FALLBACK' };
    STORE.vinMapUpdatedAt = Date.now();

    // Task has a prefixed/differently formatted registration → no exact match
    // but last 4 digits (9640) should match WB25R9640
    mockFetchSequence([
      { status: 200, body: { data: { tasks: [
        { id: 'T3', vehicle_number: 'XX9640', from_date: '2026-03-01', from_time: '08:00', to_date: '2026-03-01', to_time: '20:00' }
      ] } } },
      { status: 200, body: { data: { consumption: {} } } },
    ]);

    chrome.tabs.query.mockResolvedValue([{ id: 50 }]);
    chrome.scripting.executeScript.mockResolvedValue([{
      result: { ok: true, status: 200, text: JSON.stringify({ results: [{ vin: 'VIN_FALLBACK', fuel_used: 12 }] }) },
    }]);

    await triggerPollNow();

    // Should have submitted (fallback worked)
    expect(fetch).toHaveBeenCalledTimes(2);
    const submitBody = JSON.parse(vi.mocked(fetch).mock.calls[1][1].body);
    expect(submitBody.fuel_consumed).toBe(12);
  });

  it('reports error for tasks with unresolvable VIN', async () => {
    STORE.authToken = 'jwt-ok';
    STORE.fleetToken = 'fleet-tok';
    STORE.fleetId = 'fleet-1';
    STORE.tokenExp = Math.floor(Date.now() / 1000) + 3600;
    STORE.vinMap = { WB25R9640: 'VIN001' };
    STORE.vinMapUpdatedAt = Date.now();

    // Task with unknown registration
    mockFetchSequence([
      { status: 200, body: { data: { tasks: [
        { id: 'T4', vehicle_number: 'UNKNOWN99X', from_date: '2026-03-01', from_time: '10:00', to_date: '2026-03-01', to_time: '18:00' }
      ] } } },
      // reportTaskError
      { status: 200, body: {} },
    ]);

    chrome.tabs.query.mockResolvedValue([{ id: 50 }]);

    await triggerPollNow();

    // Should have called reportTaskError (the second fetch call)
    const errorCall = vi.mocked(fetch).mock.calls[1];
    expect(errorCall[0]).toContain('/error');
    const errorBody = JSON.parse(errorCall[1].body);
    expect(errorBody.error).toContain('VIN not found');
  });
});

// ─── Flow 4: Metrics persistence ────────────────────────────────────────────

describe('Flow: metrics persistence', () => {
  it('metrics survive across module calls via chrome.storage', async () => {
    const m1 = await getMetrics();
    expect(m1.totalProcessed).toBe(0);

    await updateMetrics({ totalProcessed: 10, totalFailed: 2, lastPollAt: Date.now() });

    const m2 = await getMetrics();
    expect(m2.totalProcessed).toBe(10);
    expect(m2.totalFailed).toBe(2);
    expect(m2.lastPollAt).toBeDefined();
  });
});

// ─── Flow 5: Logger cross-module persistence ────────────────────────────────

describe('Flow: logger persistence', () => {
  it('logs from backendApi are retrievable via getLogs', async () => {
    await clearLogs();

    // login emits logger.info('Logging in to backend...')
    mockFetchSequence([
      { status: 200, body: { data: { token: 'jwt-log', user: { name: 'Logger', role: 'OWNER' } } } },
    ]);
    await login('logger@test.com', 'p');

    const logs = await getLogs(100);
    const loginLog = logs.find(l => l.message.includes('Logging in') || l.message.includes('Logged in'));
    expect(loginLog).toBeDefined();
    expect(loginLog.module).toBe('BackendAPI');
  });
});

// ─── Flow 6: reportTaskError graceful degradation ────────────────────────────

describe('Flow: reportTaskError resilience', () => {
  it('does not throw even when the backend is completely down', async () => {
    STORE.authToken = 'jwt-down';

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(reportTaskError('task-x', 'some error')).resolves.not.toThrow();
  });
});
