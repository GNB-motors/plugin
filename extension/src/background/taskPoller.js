import { getValidToken } from './tokenCapture.js';
import { fetchVehicles, fetchFuelConsumption, ApiError } from './fleetedgeApi.js';
import { fetchPendingTasks, submitTaskResult, reportTaskError, getSystemToken } from './backendApi.js';
import { buildUtcWindow, istToUtc, sleep, getStorage, setStorage, normalizeRegistration, updateMetrics, getMetrics } from './utils.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('TaskPoller');

const VIN_CACHE_TTL_MS = config.VIN_CACHE_TTL_HOURS * 60 * 60 * 1000;

let isProcessing = false;

export function initTaskPoller() {
  chrome.alarms.create('pollTasks', {
    delayInMinutes: 1,
    periodInMinutes: config.POLL_INTERVAL_MINUTES,
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'pollTasks') {
      await runPollCycle();
    }
  });

  logger.info(`Task poller initialized (interval: ${config.POLL_INTERVAL_MINUTES}m)`);
}

async function runPollCycle() {
  if (isProcessing) {
    logger.warn('Previous cycle still running, skipping');
    return;
  }

  isProcessing = true;
  const cycleStart = Date.now();
  let processed = 0;
  let failed = 0;

  try {
    const systemToken = await getSystemToken();
    if (!systemToken) {
      logger.warn('No system token, skipping');
      return;
    }

    const tokenState = await getValidToken();
    if (!tokenState.valid) {
      logger.warn('FleetEdge token invalid, skipping');
      return;
    }

    const { token, fleetId } = tokenState;

    let tasks;
    try {
      tasks = await fetchPendingTasks(systemToken);
    } catch (err) {
      logger.error('Failed to fetch tasks:', err.message);
      await updateMetrics({ lastPollAt: Date.now(), lastError: err.message, lastErrorAt: Date.now() });
      return;
    }

    if (!tasks.length) {
      updateBadgeCount(0);
      await updateMetrics({ lastPollAt: Date.now() });
      return;
    }

    logger.info(`Processing ${tasks.length} task(s)`);
    updateBadgeCount(tasks.length);

    const vinMap = await getOrRefreshVinMap(token, fleetId);

    for (let i = 0; i < tasks.length; i++) {
      const task = tasks[i];
      logger.info(`Task ${i + 1}/${tasks.length}: ${task.id}`);

      const recheck = await getValidToken();
      if (!recheck.valid) {
        logger.warn('Token expired mid-batch, stopping');
        break;
      }

      try {
        await processTask(task, recheck.token, fleetId, vinMap, systemToken);
        processed++;
      } catch (err) {
        failed++;
        logger.error(`Task ${task.id} failed:`, err.message);

        if (err instanceof ApiError && err.status === 401) {
          logger.warn('Session lost, stopping batch');
          break;
        }

        await reportTaskError(systemToken, task.id, err.message);
      }

      if (i < tasks.length - 1) {
        await sleep(config.INTER_TASK_DELAY_MS);
      }
    }
  } catch (err) {
    logger.error('Unexpected poll cycle error:', err);
  } finally {
    isProcessing = false;

    const elapsed = Date.now() - cycleStart;
    logger.info(`Cycle done: ${processed} ok, ${failed} failed (${elapsed}ms)`);

    const current = await getMetrics();
    await updateMetrics({
      totalProcessed: current.totalProcessed + processed,
      totalFailed: current.totalFailed + failed,
      lastPollAt: Date.now(),
      lastCycleDurationMs: elapsed,
      ...(failed > 0 ? { lastErrorAt: Date.now() } : {}),
    });
  }
}

/**
 * Resolve the UTC time window for a task.
 *
 * Supports two formats:
 *  1. Explicit range — from_date, from_time, to_date, to_time (recommended).
 *     Uses istToUtc() on each endpoint for exact start/end conversion.
 *  2. Point-in-time  — refuel_date, refuel_time (legacy).
 *     Builds a ±SEARCH_WINDOW_MINUTES window around the refuel moment.
 *
 * Explicit range takes priority when both sets of fields are present.
 */
function resolveTimeWindow(task) {
  const hasExplicitRange = task.from_date && task.from_time && task.to_date && task.to_time;

  if (hasExplicitRange) {
    return {
      from: istToUtc(task.from_date, task.from_time),
      to:   istToUtc(task.to_date, task.to_time),
    };
  }

  if (task.refuel_date && task.refuel_time) {
    return buildUtcWindow(task.refuel_date, task.refuel_time, config.SEARCH_WINDOW_MINUTES);
  }

  return null;
}

function validateTask(task) {
  if (!task.id) return 'missing id';
  if (!task.vehicle_number) return 'missing vehicle_number';

  const window = resolveTimeWindow(task);
  if (!window) {
    return 'missing time fields — provide either (from_date + from_time + to_date + to_time) or (refuel_date + refuel_time)';
  }

  return null;
}

async function processTask(task, token, fleetId, vinMap, systemToken) {
  const validationError = validateTask(task);
  if (validationError) {
    throw new Error(`Task ${task.id}: ${validationError}`);
  }

  const normalizedReg = normalizeRegistration(task.vehicle_number);
  const vin = vinMap[normalizedReg];

  if (!vin) {
    throw new Error(`VIN not found for registration: ${task.vehicle_number}`);
  }

  const { from, to } = resolveTimeWindow(task);
  logger.debug(`Task ${task.id}: ${task.vehicle_number} → ${vin} | ${from} → ${to}`);

  const response = await fetchFuelConsumption(token, fleetId, [vin], from, to);
  const results = response.results || [];

  logger.info(`Task ${task.id}: ${results.length} result(s), submitting`);
  await submitTaskResult(systemToken, task.id, results);
}

async function getOrRefreshVinMap(token, fleetId) {
  const store = await getStorage(['vinMap', 'vinMapUpdatedAt']);

  const now = Date.now();
  const age = now - (store.vinMapUpdatedAt || 0);

  if (store.vinMap && age < VIN_CACHE_TTL_MS) {
    const count = Object.keys(store.vinMap).length;
    const ageMinutes = Math.round(age / 60000);
    logger.debug(`Using cached VIN map (${count} vehicles, age: ${ageMinutes}m)`);
    return store.vinMap;
  }

  logger.info('VIN map cache expired or missing, refreshing from FleetEdge...');
  const vehicles = await fetchVehicles(token, fleetId);

  // Log first vehicle's keys so we know exactly what fields the API returns
  if (vehicles.length > 0) {
    logger.debug(`Vehicle fields: ${Object.keys(vehicles[0]).join(', ')}`);
  }

  const vinMap = {};
  for (const v of vehicles) {
    // FleetEdge may use registration_number, regn_number, reg_no, or vehicle_reg
    const reg = v.registration_number || v.regn_number || v.reg_no || v.vehicle_reg;
    if (reg && v.vin) {
      const key = normalizeRegistration(reg);
      vinMap[key] = v.vin;
    }
  }

  await setStorage({
    vinMap,
    vinMapUpdatedAt: now,
  });

  logger.info(`Cached ${Object.keys(vinMap).length} vehicle mappings`);
  return vinMap;
}

function updateBadgeCount(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

export async function forceRefreshVinMap() {
  logger.info('Force refreshing VIN map');
  const tokenState = await getValidToken();
  if (!tokenState.valid) {
    logger.warn('Cannot refresh VIN map: no valid token');
    return null;
  }

  await setStorage({ vinMapUpdatedAt: 0 });
  return getOrRefreshVinMap(tokenState.token, tokenState.fleetId);
}

export async function triggerPollNow() {
  logger.info('Manual poll triggered');
  await runPollCycle();
}
