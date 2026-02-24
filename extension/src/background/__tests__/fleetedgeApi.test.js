/**
 * Unit tests for src/background/fleetedgeApi.js
 *
 * Mocks: fetch (global), config, logger, utils.withRetry (pass-through).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub ─────────────────────────────────────────────────────────────
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    },
  },
});

// ─── Module mocks ────────────────────────────────────────────────────────────
vi.mock('../config.js', () => ({
  config: {
    CVP_API_BASE: 'https://cvp.api.tatamotors',
    FLEETEDGE_ORIGIN: 'https://fleetedge.home.tatamotors',
    MAX_RETRY_ATTEMPTS: 1,
  },
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Make withRetry a transparent pass-through so we isolate fleetedgeApi logic
vi.mock('../utils.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, withRetry: (fn) => fn() };
});

const { fetchVehicles, fetchFuelConsumption, ApiError } = await import('../fleetedgeApi.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────
function mockFetch(status, body) {
  const json = typeof body === 'string' ? body : JSON.stringify(body);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(json),
  }));
}

beforeEach(() => { vi.restoreAllMocks(); });

// ─── fetchVehicles ────────────────────────────────────────────────────────────
describe('fetchVehicles', () => {
  it('returns the results array on a 200 response', async () => {
    const vehicles = [{ vin: 'ABC123', registration: 'WB01A0001' }];
    mockFetch(200, { results: vehicles });

    const result = await fetchVehicles('token-abc', 'fleet-1');
    expect(result).toEqual(vehicles);
  });

  it('returns empty array when results field is absent', async () => {
    mockFetch(200, {});
    const result = await fetchVehicles('token', 'fleet');
    expect(result).toEqual([]);
  });

  it('throws ApiError with status 401 on unauthorised response', async () => {
    mockFetch(401, {});
    await expect(fetchVehicles('bad-token', 'fleet')).rejects.toThrow(ApiError);
    await expect(fetchVehicles('bad-token', 'fleet')).rejects.toMatchObject({ status: 401 });
  });

  it('throws ApiError on generic server error', async () => {
    mockFetch(500, 'Internal Server Error');
    await expect(fetchVehicles('token', 'fleet')).rejects.toThrow(ApiError);
  });

  it('calls fetch with the correct URL and Authorization header', async () => {
    mockFetch(200, { results: [] });
    await fetchVehicles('my-token', 'fleet-42');
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain('/get-vehicles');
    expect(opts.headers['Authorization']).toBe('Bearer my-token');
  });
});

// ─── fetchFuelConsumption ─────────────────────────────────────────────────────
describe('fetchFuelConsumption', () => {
  const FROM = '2026-02-13T21:50:00.000Z';
  const TO   = '2026-02-18T09:20:00.000Z';
  const VINS = ['MAT828113S2C05629'];

  it('returns the full data object on success', async () => {
    const data = { results: [{ vin: VINS[0], fuel_used: 45.2 }] };
    mockFetch(200, data);

    const result = await fetchFuelConsumption('token', 'fleet', VINS, FROM, TO);
    expect(result).toEqual(data);
    expect(result.results).toHaveLength(1);
  });

  it('returns data with empty results array when none found', async () => {
    mockFetch(200, { results: [] });
    const result = await fetchFuelConsumption('token', 'fleet', VINS, FROM, TO);
    expect(result.results).toEqual([]);
  });

  it('throws ApiError on 401', async () => {
    mockFetch(401, {});
    await expect(fetchFuelConsumption('token', 'fleet', VINS, FROM, TO))
      .rejects.toMatchObject({ status: 401 });
  });

  it('sends from_datetime and to_datetime in the request body', async () => {
    mockFetch(200, { results: [] });
    await fetchFuelConsumption('token', 'fleet', VINS, FROM, TO);
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.from_datetime).toBe(FROM);
    expect(body.to_datetime).toBe(TO);
    expect(body.vins).toEqual(VINS);
  });
});
