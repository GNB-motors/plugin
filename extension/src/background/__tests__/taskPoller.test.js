/**
 * Unit tests for src/background/taskPoller.js
 *
 * Tests the exported helpers and core poll-cycle path by mocking
 * all external dependencies (backendApi, fleetedgeApi, tokenCapture, storage).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub ─────────────────────────────────────────────────────────────
const ALARMS = {};
vi.stubGlobal('chrome', {
  alarms: {
    create: vi.fn((name, opts) => { ALARMS[name] = opts; }),
    onAlarm: { addListener: vi.fn() },
  },
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    },
  },
  notifications: {
    create: vi.fn(),
  },
  action: {
    setBadgeText: vi.fn(),
    setBadgeBackgroundColor: vi.fn(),
  },
});

// ─── Shared mock state ────────────────────────────────────────────────────────
const mockTokenState = { valid: true, token: 'fleet-tok', fleetId: 'fleet-1', remainingSeconds: 3600 };
const mockTasks      = [];

vi.mock('../config.js', () => ({
  config: {
    POLL_INTERVAL_MINUTES: 5,
    INTER_TASK_DELAY_MS: 0,
    VIN_CACHE_TTL_HOURS: 24,
    SEARCH_WINDOW_MINUTES: 30,
    TOKEN_EXPIRY_BUFFER_SECONDS: 60,
    CVP_API_BASE: 'https://cvp.api.tatamotors',
    FLEETEDGE_ORIGIN: 'https://fleetedge.home.tatamotors',
  },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../tokenCapture.js', () => ({
  getValidToken: vi.fn(() => Promise.resolve(mockTokenState)),
}));

vi.mock('../backendApi.js', () => ({
  getSystemToken: vi.fn(() => Promise.resolve('sys-token')),
  fetchPendingTasks: vi.fn(() => Promise.resolve(mockTasks)),
  submitTaskResult: vi.fn(() => Promise.resolve({})),
  reportTaskError: vi.fn(() => Promise.resolve()),
}));

vi.mock('../fleetedgeApi.js', () => ({
  fetchVehicles: vi.fn(() => Promise.resolve([])),
  fetchFuelConsumption: vi.fn(() => Promise.resolve({ results: [] })),
  ApiError: class ApiError extends Error {
    constructor(msg, status) { super(msg); this.name = 'ApiError'; this.status = status; }
  },
}));

const { initTaskPoller, triggerPollNow } = await import('../taskPoller.js');
import { fetchPendingTasks, submitTaskResult, reportTaskError } from '../backendApi.js';
import { getValidToken } from '../tokenCapture.js';
import { fetchFuelConsumption } from '../fleetedgeApi.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockTasks.length = 0;
  // Reset token to valid by default
  Object.assign(mockTokenState, { valid: true, token: 'fleet-tok', fleetId: 'fleet-1', remainingSeconds: 3600 });
  // Reset mock resolved values
  vi.mocked(getValidToken).mockResolvedValue({ ...mockTokenState });
  vi.mocked(fetchPendingTasks).mockResolvedValue([]);
  vi.mocked(submitTaskResult).mockResolvedValue({});
  vi.mocked(reportTaskError).mockResolvedValue();
});

// ─── initTaskPoller ───────────────────────────────────────────────────────────
describe('initTaskPoller', () => {
  it('registers a "pollTasks" chrome alarm', () => {
    initTaskPoller();
    expect(chrome.alarms.create).toHaveBeenCalledWith(
      'pollTasks',
      expect.objectContaining({ periodInMinutes: expect.any(Number) })
    );
  });
});

// ─── triggerPollNow — no token ────────────────────────────────────────────────
describe('triggerPollNow', () => {
  it('returns early without calling fetchPendingTasks when token is invalid', async () => {
    vi.mocked(getValidToken).mockResolvedValueOnce({ valid: false });
    await triggerPollNow();
    expect(fetchPendingTasks).not.toHaveBeenCalled();
  });

  it('returns early without calling fetchPendingTasks when there is no system token', async () => {
    const { getSystemToken } = await import('../backendApi.js');
    vi.mocked(getSystemToken).mockResolvedValueOnce(null);
    await triggerPollNow();
    expect(fetchPendingTasks).not.toHaveBeenCalled();
  });

  it('processes zero tasks gracefully', async () => {
    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([]);
    await expect(triggerPollNow()).resolves.not.toThrow();
    expect(submitTaskResult).not.toHaveBeenCalled();
  });

  it('calls reportTaskError when VIN is not found for a task', async () => {
    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([
      { id: 'task-1', vehicle_number: 'UNKNOWN99', refuel_date: '2026-01-01', refuel_time: '12:00' },
    ]);
    chrome.storage.local.get.mockReturnValue(Promise.resolve({}));

    await triggerPollNow();

    expect(reportTaskError).toHaveBeenCalledWith(
      expect.any(String),
      'task-1',
      expect.stringContaining('VIN not found')
    );
    expect(submitTaskResult).not.toHaveBeenCalled();
  });

  // ─── Legacy format: refuel_date + refuel_time (±window) ────────────────────
  it('processes a legacy task with refuel_date/refuel_time and builds a ±30min window', async () => {
    const vinMap = { WB25R9640: 'MAT828113S2C05629' };
    chrome.storage.local.get.mockReturnValue(
      Promise.resolve({ vinMap, vinMapUpdatedAt: Date.now() })
    );

    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([
      { id: 'task-legacy', vehicle_number: 'WB25R9640', refuel_date: '2026-02-21', refuel_time: '14:30' },
    ]);
    vi.mocked(fetchFuelConsumption).mockResolvedValueOnce({
      results: [{ vin: 'MAT828113S2C05629', fuel_used: 88.5 }],
    });

    await triggerPollNow();

    expect(fetchFuelConsumption).toHaveBeenCalled();
    // Verify the time window is ~60 minutes wide (±30 around center)
    const [, , , fromUtc, toUtc] = fetchFuelConsumption.mock.calls[0];
    const diffMs = new Date(toUtc).getTime() - new Date(fromUtc).getTime();
    expect(diffMs).toBe(60 * 60 * 1000); // 60 minutes
    expect(submitTaskResult).toHaveBeenCalledWith(
      expect.any(String),
      'task-legacy',
      expect.arrayContaining([expect.objectContaining({ vin: 'MAT828113S2C05629' })])
    );
  });

  // ─── Explicit range: from_date/from_time → to_date/to_time ─────────────────
  it('processes a task with explicit from/to range (Feb 14 03:20 → Feb 18 14:50 IST)', async () => {
    const vinMap = { WB25R9640: 'MAT828113S2C05629' };
    chrome.storage.local.get.mockReturnValue(
      Promise.resolve({ vinMap, vinMapUpdatedAt: Date.now() })
    );

    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([
      {
        id: 'task-range',
        vehicle_number: 'WB25R9640',
        from_date: '2026-02-14',
        from_time: '03:20',
        to_date: '2026-02-18',
        to_time: '14:50',
      },
    ]);
    vi.mocked(fetchFuelConsumption).mockResolvedValueOnce({
      results: [{ vin: 'MAT828113S2C05629', fuel_used: 95.3, distance_covered: 720 }],
    });

    await triggerPollNow();

    expect(fetchFuelConsumption).toHaveBeenCalled();

    // Verify exact UTC conversion: IST 2026-02-14 03:20 → UTC 2026-02-13 21:50
    //                               IST 2026-02-18 14:50 → UTC 2026-02-18 09:20
    const [, , , fromUtc, toUtc] = fetchFuelConsumption.mock.calls[0];
    expect(fromUtc).toBe('2026-02-13T21:50:00.000');
    expect(toUtc).toBe('2026-02-18T09:20:00.000');

    expect(submitTaskResult).toHaveBeenCalledWith(
      expect.any(String),
      'task-range',
      expect.arrayContaining([expect.objectContaining({ fuel_used: 95.3 })])
    );
  });

  it('explicit range takes priority over refuel_date/refuel_time when both are present', async () => {
    const vinMap = { MH12AB1234: 'VIN999' };
    chrome.storage.local.get.mockReturnValue(
      Promise.resolve({ vinMap, vinMapUpdatedAt: Date.now() })
    );

    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([
      {
        id: 'task-both',
        vehicle_number: 'MH12AB1234',
        from_date: '2026-02-14',
        from_time: '03:20',
        to_date: '2026-02-18',
        to_time: '14:50',
        refuel_date: '2026-02-15',
        refuel_time: '10:00',
      },
    ]);
    vi.mocked(fetchFuelConsumption).mockResolvedValueOnce({ results: [] });

    await triggerPollNow();

    // Should use the explicit range, not the refuel_date window
    const [, , , fromUtc, toUtc] = fetchFuelConsumption.mock.calls[0];
    expect(fromUtc).toBe('2026-02-13T21:50:00.000');
    expect(toUtc).toBe('2026-02-18T09:20:00.000');
  });

  it('reports error when task is missing all time fields', async () => {
    const vinMap = { WB25R9640: 'VIN001' };
    chrome.storage.local.get.mockReturnValue(
      Promise.resolve({ vinMap, vinMapUpdatedAt: Date.now() })
    );

    vi.mocked(fetchPendingTasks).mockResolvedValueOnce([
      { id: 'task-bad', vehicle_number: 'WB25R9640' },
    ]);

    await triggerPollNow();

    expect(reportTaskError).toHaveBeenCalledWith(
      expect.any(String),
      'task-bad',
      expect.stringContaining('missing time fields')
    );
    expect(submitTaskResult).not.toHaveBeenCalled();
  });
});
