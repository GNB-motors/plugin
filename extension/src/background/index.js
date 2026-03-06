import { initTokenCapture, getValidToken } from './tokenCapture.js';
import { initTaskPoller, triggerPollNow, forceRefreshVinMap } from './taskPoller.js';
import { getStorage, setStorage, removeStorage, getMetrics, normalizeRegistration, istToUtc } from './utils.js';
import { getLogs, clearLogs, createLogger } from './logger.js';
import { fetchFuelConsumption } from './fleetedgeApi.js';
import { login, logout, isAuthenticated } from './backendApi.js';
import { startTelemetry, record, LAYERS, createLayerLogger, getEvents, clearEvents, getStats, getHealthSnapshot, getBreadcrumbs } from './telemetry.js';

const logger = createLogger('ServiceWorker');
const tlog = createLayerLogger(LAYERS.MESSAGE);

initTokenCapture();
initTaskPoller();
startTelemetry();

logger.info('FleetEdge Fuel Monitor initialized');

// Auto-poll on startup if already authenticated
isAuthenticated().then((authed) => {
  if (authed) {
    logger.info('Already authenticated — triggering initial poll');
    triggerPollNow();
  }
}).catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    logger.error('Message handler error', err.message);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message) {
  switch (message.type) {

    case 'LOGIN': {
      const { emailOrMobile, password } = message;
      if (!emailOrMobile || !password) throw new Error('Email/mobile and password are required');
      const result = await login(emailOrMobile, password);
      // Auto-trigger poll after successful login
      triggerPollNow();
      return { success: true, user: result.user };
    }

    case 'LOGOUT': {
      await logout();
      chrome.action.setBadgeText({ text: '' });
      return { success: true };
    }

    case 'GET_AUTH_STATUS': {
      const store = await getStorage(['authToken', 'authUser']);
      return {
        authenticated: !!store.authToken,
        user: store.authUser || null,
      };
    }

    case 'GET_STATUS': {
      const store = await getStorage([
        'fleetToken', 'fleetId', 'tokenExp', 'tokenCapturedAt',
        'authToken', 'authUser', 'backendUrl', 'vinMap', 'vinMapUpdatedAt',
      ]);

      const tokenState = store.fleetToken
        ? await getValidToken()
        : { valid: false };

      const metrics = await getMetrics();

      return {
        hasFleetToken: !!store.fleetToken,
        tokenValid: tokenState.valid,
        remainingSeconds: tokenState.remainingSeconds || 0,
        fleetId: store.fleetId || null,
        authenticated: !!store.authToken,
        user: store.authUser || null,
        backendUrl: store.backendUrl || null,
        vehicleCount: store.vinMap ? Object.keys(store.vinMap).length : 0,
        vinMapAge: store.vinMapUpdatedAt
          ? Math.round((Date.now() - store.vinMapUpdatedAt) / 60000)
          : null,
        metrics,
      };
    }

    case 'SET_BACKEND_URL': {
      if (!message.url) throw new Error('URL is required');
      await setStorage({ backendUrl: message.url });
      logger.info(`Backend URL updated: ${message.url}`);
      return { success: true };
    }

    case 'TRIGGER_POLL': {
      triggerPollNow();
      return { success: true, message: 'Poll triggered' };
    }

    case 'REFRESH_VEHICLES': {
      try {
        const map = await forceRefreshVinMap();
        if (!map) return { success: false, error: 'No valid FleetEdge token — log in to FleetEdge first' };
        return { success: true, count: Object.keys(map).length };
      } catch (err) {
        logger.error('Vehicle refresh failed', err.message);
        return { success: false, error: err.message };
      }
    }

    case 'GET_LOGS': {
      const logs = await getLogs(message.limit || 100);
      return { logs };
    }

    case 'CLEAR_LOGS': {
      await clearLogs();
      return { success: true };
    }

    case 'MANUAL_FETCH': {
      const { identifier, fromDate, fromTime, toDate, toTime } = message;
      if (!identifier || !fromDate || !fromTime || !toDate || !toTime) {
        throw new Error('identifier, fromDate, fromTime, toDate, toTime are all required');
      }

      const tokenState = await getValidToken(60);
      if (!tokenState.valid) throw new Error('No valid FleetEdge token — please log into FleetEdge first');

      const store = await getStorage(['vinMap', 'fleetId']);
      if (!store.fleetId) throw new Error('Fleet ID not found — capture a token first');

      const isVin = /^[A-Z0-9]{14,20}$/i.test(identifier.trim());
      let vin;
      let registration = null;

      if (isVin) {
        vin = identifier.trim().toUpperCase();
        logger.info(`Manual fetch: using VIN directly: ${vin}`);
      } else {
        registration = normalizeRegistration(identifier);
        vin = store.vinMap?.[registration];

        // Last-4-digit fallback
        if (!vin) {
          const last4 = registration.slice(-4);
          const fallbackKey = Object.keys(store.vinMap || {}).find((k) => k.endsWith(last4));
          if (fallbackKey) {
            vin = store.vinMap[fallbackKey];
            logger.info(`Manual fetch fallback: last4=${last4} → ${fallbackKey} → ${vin}`);
          }
        }

        if (!vin) {
          throw new Error(
            `VIN not found for registration "${identifier}" — try Refresh Vehicles first, or enter the VIN/chassis directly`
          );
        }
        logger.info(`Manual fetch: ${registration} → VIN ${vin}`);
      }

      const fromUtc = istToUtc(fromDate, fromTime);
      const toUtc   = istToUtc(toDate,   toTime);
      logger.info(`Manual fetch window: ${fromUtc} → ${toUtc}`);

      const data = await fetchFuelConsumption(
        tokenState.token,
        store.fleetId,
        [vin],
        fromUtc,
        toUtc
      );

      const payload = {
        source: 'manual_query',
        vin,
        registration,
        identifier,
        fleetId: store.fleetId,
        fromIst: `${fromDate} ${fromTime}`,
        toIst:   `${toDate} ${toTime}`,
        fromUtc,
        toUtc,
        fetchedAt: new Date().toISOString(),
        resultCount: (data.results || []).length,
        results: data.results || [],
        rawResponse: data,
      };

      await setStorage({ manualQueryResult: payload });

      logger.info(`Manual fetch done: ${payload.resultCount} record(s)`);
      return { success: true, vin, registration, resultCount: payload.resultCount, data };
    }

    case 'GET_MANUAL_RESULT': {
      const store = await getStorage(['manualQueryResult']);
      return { result: store.manualQueryResult || null };
    }

    case 'CLEAR_ALL': {
      await removeStorage([
        'fleetToken', 'fleetId', 'tokenExp', 'tokenCapturedAt',
        'authToken', 'authUser', 'backendUrl', 'vinMap', 'vinMapUpdatedAt',
        'metrics', 'manualQueryResult',
      ]);
      chrome.action.setBadgeText({ text: '' });
      logger.info('All data cleared');
      return { success: true };
    }

    // ─── LEMU Telemetry Messages ─────────────────────────────────────────
    case 'GET_TELEMETRY': {
      tlog.debug('Querying telemetry events');
      const events = await getEvents(message.filters || {});
      return { events };
    }

    case 'GET_TELEMETRY_STATS': {
      const stats = await getStats();
      return { stats };
    }

    case 'GET_HEALTH': {
      const health = await getHealthSnapshot();
      return { health };
    }

    case 'GET_BREADCRUMBS': {
      return { breadcrumbs: getBreadcrumbs() };
    }

    case 'CLEAR_TELEMETRY': {
      await clearEvents();
      tlog.info('Telemetry cleared');
      return { success: true };
    }

    case 'FLUSH_TELEMETRY': {
      // Force flush events to storage and trigger backend ship
      record(LAYERS.MESSAGE, 'INFO', 'Manual flush triggered');
      return { success: true };
    }

    default:
      throw new Error(`Unknown message type: ${message.type}`);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    logger.info('Extension installed');
    chrome.action.setBadgeText({ text: '?' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else if (details.reason === 'update') {
    logger.info(`Extension updated to ${chrome.runtime.getManifest().version}`);
  }
});
