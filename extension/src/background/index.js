import { initTokenCapture, getValidToken } from './tokenCapture.js';
import { initTaskPoller, triggerPollNow, forceRefreshVinMap } from './taskPoller.js';
import { getStorage, setStorage, removeStorage, getMetrics, normalizeRegistration, istToUtc } from './utils.js';
import { getLogs, clearLogs, createLogger } from './logger.js';
import { fetchFuelConsumption } from './fleetedgeApi.js';

const logger = createLogger('ServiceWorker');

initTokenCapture();
initTaskPoller();

logger.info('FleetEdge Fuel Monitor initialized');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message).then(sendResponse).catch(err => {
    logger.error('Message handler error', err.message);
    sendResponse({ error: err.message });
  });
  return true;
});

async function relayToBackend(payload) {
  const store = await getStorage(['backendUrl', 'systemToken']);

  if (!store.backendUrl || !store.systemToken) {
    logger.warn('Backend not configured — result stored locally only');
    return { relayed: false, reason: 'no_backend' };
  }

  const url = `${store.backendUrl.replace(/\/+$/, '')}/fuel-data/ingest`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${store.systemToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logger.error(`Backend relay failed: ${res.status}`, text.slice(0, 200));
      return { relayed: false, reason: `http_${res.status}`, detail: text.slice(0, 200) };
    }

    const result = await res.json().catch(() => ({}));
    logger.info(`Relayed to backend: ${url}`);
    return { relayed: true, backendResponse: result };

  } catch (err) {
    logger.error('Backend relay network error', err.message);
    return { relayed: false, reason: 'network_error', detail: err.message };
  }
}

async function handleMessage(message) {
  switch (message.type) {

    case 'GET_STATUS': {
      const store = await getStorage([
        'fleetToken', 'fleetId', 'tokenExp', 'tokenCapturedAt',
        'systemToken', 'backendUrl', 'vinMap', 'vinMapUpdatedAt',
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
        hasSystemToken: !!store.systemToken,
        backendUrl: store.backendUrl || null,
        vehicleCount: store.vinMap ? Object.keys(store.vinMap).length : 0,
        vinMapAge: store.vinMapUpdatedAt
          ? Math.round((Date.now() - store.vinMapUpdatedAt) / 60000)
          : null,
        metrics,
      };
    }

    case 'SET_SYSTEM_TOKEN': {
      if (!message.token) throw new Error('Token is required');
      await setStorage({ systemToken: message.token });
      logger.info('System token updated');
      return { success: true };
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
      // message: { identifier, fromDate, fromTime, toDate, toTime }
      // identifier = registration number (e.g. "WB25R9640")
      //            OR VIN/chassis (e.g. "MAT828113S2C05629")
      const { identifier, fromDate, fromTime, toDate, toTime } = message;
      if (!identifier || !fromDate || !fromTime || !toDate || !toTime) {
        throw new Error('identifier, fromDate, fromTime, toDate, toTime are all required');
      }

      const tokenState = await getValidToken(60);
      if (!tokenState.valid) throw new Error('No valid FleetEdge token — please log into FleetEdge first');

      const store = await getStorage(['vinMap', 'fleetId']);
      if (!store.fleetId) throw new Error('Fleet ID not found — capture a token first');

      // Auto-detect: 17-char alphanumeric = VIN/chassis, else treat as registration
      const isVin = /^[A-Z0-9]{14,20}$/i.test(identifier.trim());
      let vin;
      let registration = null;

      if (isVin) {
        vin = identifier.trim().toUpperCase();
        logger.info(`Manual fetch: using VIN directly: ${vin}`);
      } else {
        registration = normalizeRegistration(identifier);
        vin = store.vinMap?.[registration];
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

      const relay = await relayToBackend(payload);

      logger.info(
        `Manual fetch done: ${payload.resultCount} record(s)` +
        (relay.relayed ? ' — relayed ✓' : ` — local only (${relay.reason})`)
      );

      return { success: true, vin, registration, resultCount: payload.resultCount, data, relay };
    }

    case 'GET_MANUAL_RESULT': {
      const store = await getStorage(['manualQueryResult']);
      return { result: store.manualQueryResult || null };
    }

    case 'CLEAR_ALL': {
      await removeStorage([
        'fleetToken', 'fleetId', 'tokenExp', 'tokenCapturedAt',
        'systemToken', 'backendUrl', 'vinMap', 'vinMapUpdatedAt',
        'metrics', 'manualQueryResult',
      ]);
      chrome.action.setBadgeText({ text: '' });
      logger.info('All data cleared');
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
