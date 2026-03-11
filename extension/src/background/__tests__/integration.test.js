/**
 * Integration tests — cross-module flows (CWS-compliant version).
 *
 * Exercises real data flow across backendApi ↔ fleetedgeLink ↔ utils ↔ logger
 * without mocking internal modules. Only external boundaries
 * (chrome.storage, fetch, chrome.tabs) are stubbed.
 *
 * Removed: tokenCapture, fleetedgeApi, taskPoller, chrome.scripting,
 * chrome.webRequest — all FleetEdge work now happens on the backend.
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
  tabs: { query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn() },
});

vi.mock('../config.js', () => ({
  config: {
    BACKEND_BASE_URL: 'http://localhost:3000',
    API_PREFIX: '/api/extension',
    STATUS_POLL_INTERVAL_MINUTES: 2,
    LOG_RETENTION_COUNT: 100,
    MAX_RETRY_ATTEMPTS: 2,
  },
}));

// Import real (not mocked) modules — tests their interaction via shared storage
const { login, logout, isAuthenticated, backendFetch, fetchStatus } =
  await import('../backendApi.js');
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

// ─── Flow 1: Login → auth check → fetch status ──────────────────────────────

describe('Flow: login → fetchStatus', () => {
  it('full authenticated round-trip', async () => {
    // 1. Login
    mockFetchSequence([
      { status: 200, body: { data: { token: 'jwt-int-1', user: { name: 'Tester', role: 'OWNER' } } } },
    ]);
    const res = await login('tester@org.com', 'secure');
    expect(res.token).toBe('jwt-int-1');
    expect(await isAuthenticated()).toBe(true);

    // 2. Fetch backend status
    mockFetchSequence([
      { status: 200, body: { data: { pending: 5, completed: 10, failed: 1, flagged: 2 } } },
    ]);
    const statusRes = await fetchStatus();
    expect(statusRes.data.pending).toBe(5);
    expect(statusRes.data.completed).toBe(10);
  });

  it('uses stored backendUrl over config default', async () => {
    STORE.backendUrl = 'https://custom-api.example.com';
    STORE.authToken = 'jwt-custom';

    mockFetchSequence([
      { status: 200, body: { data: {} } },
    ]);
    await fetchStatus();

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

    await expect(backendFetch('/status')).rejects.toThrow();
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

// ─── Flow 3: FleetEdge link via backend ──────────────────────────────────────

describe('Flow: FleetEdge link', () => {
  it('backendFetch calls FleetEdge link-token endpoint', async () => {
    STORE.authToken = 'jwt-ok';

    mockFetchSequence([
      { status: 200, body: { data: { success: true, vehicleCount: 15, expiresAt: 9999999999 } } },
    ]);

    const response = await backendFetch('/fleetedge/link-token', {
      method: 'POST',
      body: JSON.stringify({ token: 'fleet-jwt', fleetId: 'F123' }),
    });
    const data = await response.json();

    expect(data.data.success).toBe(true);
    expect(data.data.vehicleCount).toBe(15);

    const [calledUrl] = vi.mocked(fetch).mock.calls[0];
    expect(calledUrl).toContain('/fleetedge/link-token');
  });

  it('backendFetch calls FleetEdge status endpoint', async () => {
    STORE.authToken = 'jwt-ok';

    mockFetchSequence([
      { status: 200, body: { data: { status: 'linked', fleetId: 'F123', remainingSeconds: 3600 } } },
    ]);

    const response = await backendFetch('/fleetedge/status');
    const data = await response.json();

    expect(data.data.status).toBe('linked');
    expect(data.data.remainingSeconds).toBe(3600);
  });

  it('backendFetch calls FleetEdge process-tasks endpoint', async () => {
    STORE.authToken = 'jwt-ok';

    mockFetchSequence([
      { status: 200, body: { data: { processed: 3, failed: 1, skipped: 0, errors: [] } } },
    ]);

    const response = await backendFetch('/fleetedge/process-tasks', { method: 'POST' });
    const data = await response.json();

    expect(data.data.processed).toBe(3);
    expect(data.data.failed).toBe(1);
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
