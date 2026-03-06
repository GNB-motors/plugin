/**
 * Unit tests for src/background/fleetedgeApi.js
 *
 * fleetedgeApi.js injects fetch() calls into the open FleetEdge browser tab via
 * chrome.scripting.executeScript so the request carries the correct Origin and
 * session cookies automatically (Chrome service workers cannot spoof Origin).
 *
 * These tests mock chrome.tabs.query + chrome.scripting.executeScript instead of
 * global fetch.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Module mocks (must be before the import of the module under test) ────────
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../config.js', () => ({
  config: { CVP_API_BASE: 'https://cvp.api.tatamotors' },
}));

// Make withRetry a transparent pass-through so we isolate fleetedgeApi logic
vi.mock('../utils.js', () => ({
  withRetry: vi.fn((fn) => fn()),
}));

// ─── Chrome stub (tabs + scripting) ──────────────────────────────────────────
const mockTabsQuery    = vi.fn();
const mockExecuteScript = vi.fn();

vi.stubGlobal('chrome', {
  tabs:      { query: mockTabsQuery },
  scripting: { executeScript: mockExecuteScript },
  storage:   { local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn() } },
});

const { fetchVehicles, fetchFuelConsumption, ApiError } = await import('../fleetedgeApi.js');

// ─── Helpers ──────────────────────────────────────────────────────────────────
/** Build a resolved executeScript return value for a successful JSON response. */
function scriptOk(data) {
  return [{ result: { ok: true, status: 200, text: JSON.stringify(data) } }];
}

/** Build a resolved executeScript return value for a failed response. */
function scriptErr(status, text = '') {
  return [{ result: { ok: false, status, text } }];
}

const TAB_ID      = 42;
const TOKEN       = 'test-token-123';
const FLEET_ID    = 'fleet-001';

beforeEach(() => {
  vi.clearAllMocks();
  // Default: one open FleetEdge tab
  mockTabsQuery.mockResolvedValue([{ id: TAB_ID }]);
});

// ─── fetchVehicles ────────────────────────────────────────────────────────────
describe('fetchVehicles', () => {
  it('returns vehicles from the result (singular) field', async () => {
    const vehicles = [
      { vin: 'VIN001', registration_number: 'WB25R9640' },
      { vin: 'VIN002', registration_number: 'MH12AB1234' },
    ];
    mockExecuteScript.mockResolvedValue(scriptOk({ result: vehicles }));

    const out = await fetchVehicles(TOKEN, FLEET_ID);
    expect(out).toEqual(vehicles);
  });

  it('falls back to results (plural) field when result is absent', async () => {
    const vehicles = [{ vin: 'VINX', registration_number: 'DL1AB0001' }];
    mockExecuteScript.mockResolvedValue(scriptOk({ results: vehicles }));

    const out = await fetchVehicles(TOKEN, FLEET_ID);
    expect(out).toEqual(vehicles);
  });

  it('returns empty array when both result and results are absent', async () => {
    mockExecuteScript.mockResolvedValue(scriptOk({ status: 0 }));
    const out = await fetchVehicles(TOKEN, FLEET_ID);
    expect(out).toEqual([]);
  });

  it('calls get-vin-for-dashboard endpoint with fleet_id and req_by: PORTALS', async () => {
    mockExecuteScript.mockResolvedValue(scriptOk({ result: [] }));

    await fetchVehicles(TOKEN, FLEET_ID);

    const scriptCall = mockExecuteScript.mock.calls[0][0];
    const [url, token, body] = scriptCall.args;
    expect(url).toContain('/api/vehicle-service/get-vin-for-dashboard');
    expect(token).toBe(TOKEN);
    expect(body).toMatchObject({ fleet_id: FLEET_ID, req_by: 'PORTALS' });
  });

  it('targets the correct tab id returned by tabs.query', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 99 }]);
    mockExecuteScript.mockResolvedValue(scriptOk({ result: [] }));

    await fetchVehicles(TOKEN, FLEET_ID);

    const scriptCall = mockExecuteScript.mock.calls[0][0];
    expect(scriptCall.target.tabId).toBe(99);
  });

  it('throws ApiError(0) when no FleetEdge tab is open', async () => {
    mockTabsQuery.mockResolvedValue([]);
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  it('throws ApiError(401) on session expiry', async () => {
    mockExecuteScript.mockResolvedValue(scriptErr(401));
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 401 });
  });

  it('throws ApiError(403) on forbidden response', async () => {
    mockExecuteScript.mockResolvedValue(scriptErr(403));
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 403 });
  });

  it('throws ApiError on 500 server error', async () => {
    mockExecuteScript.mockResolvedValue(scriptErr(500, 'Internal Server Error'));
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 500 });
  });

  it('throws ApiError(0) on invalid JSON response', async () => {
    mockExecuteScript.mockResolvedValue([{ result: { ok: true, status: 200, text: 'not-json{{' } }]);
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  it('throws ApiError(0) when executeScript returns no result object', async () => {
    mockExecuteScript.mockResolvedValue([{}]);
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });
});

// ─── fetchFuelConsumption ─────────────────────────────────────────────────────
describe('fetchFuelConsumption', () => {
  const VINS = ['MAT828113S2C05629'];
  const FROM = '2026-02-13T21:50:00.000';
  const TO   = '2026-02-18T09:20:00.000';

  it('returns the full data object on success', async () => {
    const data = { results: [{ vin: VINS[0], fuel_used: 363.2, distance_travelled: 1030.6 }] };
    mockExecuteScript.mockResolvedValue(scriptOk(data));

    const out = await fetchFuelConsumption(TOKEN, FLEET_ID, VINS, FROM, TO);
    expect(out).toEqual(data);
  });

  it('calls analyse-fuel-consumption with all required fields', async () => {
    mockExecuteScript.mockResolvedValue(scriptOk({ results: [] }));

    await fetchFuelConsumption(TOKEN, FLEET_ID, VINS, FROM, TO);

    const scriptCall = mockExecuteScript.mock.calls[0][0];
    const [url, token, body] = scriptCall.args;
    expect(url).toContain('/api/vehicle-service/analyse-fuel-consumption');
    expect(token).toBe(TOKEN);
    expect(body).toMatchObject({
      fleet_id:      FLEET_ID,
      vins:          VINS,
      from_datetime: FROM,
      to_datetime:   TO,
      is_testing:    true,
      data_count:    100,
      req_by:        'PORTALS',
      is_report:     true,
    });
  });

  it('throws ApiError(401) on session expiry', async () => {
    mockExecuteScript.mockResolvedValue(scriptErr(401));
    await expect(fetchFuelConsumption(TOKEN, FLEET_ID, VINS, FROM, TO))
      .rejects.toMatchObject({ name: 'ApiError', status: 401 });
  });

  it('throws ApiError(403) on forbidden response', async () => {
    mockExecuteScript.mockResolvedValue(scriptErr(403));
    await expect(fetchFuelConsumption(TOKEN, FLEET_ID, VINS, FROM, TO))
      .rejects.toMatchObject({ name: 'ApiError', status: 403 });
  });

  it('throws ApiError(0) when no FleetEdge tab is open', async () => {
    mockTabsQuery.mockResolvedValue([]);
    await expect(fetchFuelConsumption(TOKEN, FLEET_ID, VINS, FROM, TO))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });
});

// ─── ApiError ─────────────────────────────────────────────────────────────────
describe('ApiError', () => {
  it('is an Error subclass with name ApiError and a status property', () => {
    const err = new ApiError('something went wrong', 404);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ApiError');
    expect(err.status).toBe(404);
    expect(err.message).toBe('something went wrong');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Edge Cases — ⚠️ DO NOT SKIP
// FleetEdge tab injection is fragile. Users routinely have multiple FleetEdge
// tabs open. If the code picks the wrong tab, cookies/Origin don't match and
// every FleetEdge API call silently returns garbage or 403.
// ═══════════════════════════════════════════════════════════════════════════════

describe('Edge Cases', () => {
  // WHY THIS MATTERS: Users open 3-4 FleetEdge tabs (dashboard, reports, alerts).
  // Chrome's tabs.query returns all of them. The code must consistently use tabs[0]
  // — switching tabs mid-batch corrupts session cookies and triggers 403 errors.
  it('multiple FleetEdge tabs: always targets the first tab', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 10 }, { id: 20 }, { id: 30 }]);
    mockExecuteScript.mockResolvedValue(scriptOk({ result: [] }));

    await fetchVehicles(TOKEN, FLEET_ID);

    const scriptCall = mockExecuteScript.mock.calls[0][0];
    expect(scriptCall.target.tabId).toBe(10);
  });

  // WHY THIS MATTERS: If executeScript injection returns [{ result: null }]
  // (e.g., tab crashed or navigated away mid-request), the code must throw
  // ApiError — not silently return undefined and corrupt downstream parsing.
  it('executeScript returning null result throws ApiError', async () => {
    mockExecuteScript.mockResolvedValue([{ result: null }]);
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });

  // WHY THIS MATTERS: executeScript returning an empty array (rare Chrome bug on
  // extension updates) must not crash with "Cannot read properties of undefined".
  it('executeScript returning empty array throws ApiError', async () => {
    mockExecuteScript.mockResolvedValue([]);
    await expect(fetchVehicles(TOKEN, FLEET_ID))
      .rejects.toMatchObject({ name: 'ApiError', status: 0 });
  });
});
