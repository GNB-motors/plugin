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
    },
  },
});

vi.mock('../config.js', () => ({
  config: { BACKEND_BASE_URL: 'http://localhost:3000' },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { fetchPendingTasks, submitTaskResult, reportTaskError } = await import('../backendApi.js');

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

// ─── fetchPendingTasks ────────────────────────────────────────────────────────
describe('fetchPendingTasks', () => {
  it('returns task array on success', async () => {
    STORE.backendUrl = 'http://localhost:3000';
    STORE.systemToken = 'sys-token';
    const tasks = [{ id: '1', vehicle_number: 'WB25R9640' }];
    mockFetch(200, tasks);

    const result = await fetchPendingTasks('sys-token');
    expect(Array.isArray(result)).toBe(true);
  });

  it('uses config.BACKEND_BASE_URL when backendUrl is not in storage', async () => {
    STORE.systemToken = 'sys-token';
    mockFetch(200, []);
    await fetchPendingTasks('sys-token');
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('localhost:3000');
  });

  it('throws when the server returns a non-OK status', async () => {
    STORE.backendUrl = 'http://localhost:3000';
    STORE.systemToken = 'sys-token';
    mockFetch(500, { error: 'server error' });
    await expect(fetchPendingTasks('sys-token')).rejects.toThrow();
  });
});

// ─── submitTaskResult ────────────────────────────────────────────────────────
describe('submitTaskResult', () => {
  it('sends taskId and data in the request body', async () => {
    STORE.backendUrl = 'http://localhost:3000';
    STORE.systemToken = 'sys-token';
    mockFetch(200, { success: true });

    const data = { fuel_used: 42, distance: 300 };
    await submitTaskResult('sys-token', 'task-99', data);

    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ task_id: 'task-99' });
  });

  it('includes the Authorization header', async () => {
    STORE.backendUrl = 'http://localhost:3000';
    mockFetch(200, {});
    await submitTaskResult('bearer-xyz', 'task-1', {});
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect(opts.headers['Authorization']).toBe('Bearer bearer-xyz');
  });
});

// ─── reportTaskError ─────────────────────────────────────────────────────────
describe('reportTaskError', () => {
  it('does not throw even when the backend returns an error', async () => {
    STORE.backendUrl = 'http://localhost:3000';
    mockFetch(500, { error: 'fail' });
    await expect(reportTaskError('token', 'task-1', 'something went wrong')).resolves.not.toThrow();
  });

  it('does not throw when fetch itself rejects (network error)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));
    await expect(reportTaskError('token', 'task-1', 'error')).resolves.not.toThrow();
  });
});
