import { config } from './config.js';
import { withRetry } from './utils.js';
import { createLogger } from './logger.js';

const logger = createLogger('FleetEdgeAPI');

function buildHeaders(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json',
    'Origin': config.FLEETEDGE_ORIGIN,
  };
}

async function fleetFetch(path, token, body) {
  const url = `${config.CVP_API_BASE}${path}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  if (response.status === 401) throw new ApiError('Session expired', 401);
  if (response.status === 403) throw new ApiError('Forbidden', 403);

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(`${path} failed: ${response.status} ${text.slice(0, 200)}`, response.status);
  }

  return response.json();
}

export async function fetchVehicles(token, fleetId) {
  logger.info(`Fetching vehicles for fleet: ${fleetId}`);

  const data = await withRetry(
    () => fleetFetch('/api/vehicle-service/get-vehicles', token, {
      fleet_id: fleetId,
      page_number: 1,
      page_size: 5000,
    }),
    'fetchVehicles'
  );

  const results = data.results || [];
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
      data_count: 50,
      is_tipper: false,
      locale: 'en',
      req_by: 'PLUGIN',
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
