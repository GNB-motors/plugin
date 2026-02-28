import { config } from './config.js';
import { withRetry } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('FleetEdgeAPI');

/**
 * Find an open FleetEdge tab (must exist for the session cookies + correct Origin to work).
 * The FleetEdge API rejects requests that don't originate from fleetedge.home.tatamotors —
 * Chrome's security prevents service workers from spoofing the Origin header, so we
 * inject the fetch() call into the live FleetEdge tab instead.
 */
async function getFleetEdgeTab() {
  const tabs = await chrome.tabs.query({ url: 'https://fleetedge.home.tatamotors/*' });
  if (!tabs.length) {
    throw new ApiError('No FleetEdge tab open — please keep the FleetEdge website open in Chrome', 0);
  }
  return tabs[0];
}

/**
 * Execute a POST fetch inside the FleetEdge tab so the request carries the correct
 * Origin (https://fleetedge.home.tatamotors) and session cookies automatically.
 */
async function fleetFetch(path, token, body) {
  const tab = await getFleetEdgeTab();
  const url = `${config.CVP_API_BASE}${path}`;

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (fetchUrl, bearerToken, requestBody) => {
      try {
        const res = await fetch(fetchUrl, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${bearerToken}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0',
          },
          credentials: 'include',
          body: JSON.stringify(requestBody),
        });
        const text = await res.text();
        return { ok: res.ok, status: res.status, text };
      } catch (err) {
        return { ok: false, status: 0, text: err.message };
      }
    },
    args: [url, token, body],
  });

  const result = results?.[0]?.result;
  if (!result) throw new ApiError('Script injection returned no result', 0);

  if (result.status === 401) throw new ApiError('Session expired', 401);
  if (result.status === 403) throw new ApiError('Forbidden — token may have expired, re-open FleetEdge', 403);
  if (!result.ok) throw new ApiError(`${path} failed: ${result.status} ${result.text.slice(0, 200)}`, result.status);

  try {
    return JSON.parse(result.text);
  } catch {
    throw new ApiError(`Invalid JSON response from ${path}`, 0);
  }
}

export async function fetchVehicles(token, fleetId) {
  logger.info(`Fetching vehicles for fleet: ${fleetId}`);

  // get-vin-for-dashboard is what FleetEdge actually uses for the vehicle list.
  // Returns: { status: 0, result: [{ vin, vehicle_id, type_of_vehicle, registration_number, ... }] }
  const data = await withRetry(
    () => fleetFetch('/api/vehicle-service/get-vin-for-dashboard', token, {
      fleet_id: fleetId,
      req_by: 'PORTALS',
    }),
    'fetchVehicles'
  );

  // Response uses `result` (singular), not `results`
  const results = data.result || data.results || [];
  logger.info(`Fetched ${results.length} vehicles`);
  return results;
}

export async function fetchFuelConsumption(token, fleetId, vins, fromDatetime, toDatetime) {
  logger.info(`Fetching fuel consumption for ${vins.length} VIN(s)`);
  logger.debug(`Window: ${fromDatetime} → ${toDatetime}`);

  const data = await withRetry(
    () => fleetFetch('/api/vehicle-service/analyse-fuel-consumption', token, {
      page_number: 1,
      sort: 'desc',
      field_name: 'fuel_used',
      fleet_id: fleetId,
      from_datetime: fromDatetime,
      to_datetime: toDatetime,
      vins,
      is_report: true,
      is_testing: true,
      data_count: 100,
      is_tipper: false,
      req_by: 'PORTALS',
    }),
    'fetchFuelConsumption'
  );

  const results = data.results || [];
  logger.info(`Fetched fuel data: ${results.length} result(s)`);
  return data;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}
