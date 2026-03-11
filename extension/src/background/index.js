/**
 * Service Worker — FleetEdge Fuel Monitor (CWS-Compliant Rewrite)
 * ────────────────────────────────────────────────────────────────
 * All FleetEdge API calls happen on the backend. This service worker:
 *   - Handles extension auth (login/logout with backend)
 *   - Manages FleetEdge token linking via content script → backend
 *   - Polls backend for status updates
 *   - Provides UI state to the popup
 *
 * Removed: tokenCapture (webRequest), fleetedgeApi (scripting.executeScript),
 *          direct FleetEdge API calls, VIN map caching, Manual Query.
 */

import { connectFleetEdge, getFleetEdgeStatus, disconnectFleetEdge } from './fleetedgeLink.js';
import { getStorage, setStorage, removeStorage, getMetrics } from './utils.js';
import { getLogs, clearLogs, createLogger } from './logger.js';
import { login, logout, isAuthenticated, backendFetch, fetchStatus } from './backendApi.js';
import { startTelemetry, record, LAYERS, createLayerLogger, getEvents, clearEvents, getStats, getHealthSnapshot, getBreadcrumbs } from './telemetry.js';
import { config } from './config.js';

const logger = createLogger('ServiceWorker');
const tlog = createLayerLogger(LAYERS.MESSAGE);
const taskTel = createLayerLogger(LAYERS.TASK);

// ─── Status Deduplication ────────────────────────────────────────────────────
// Prevents 4 concurrent getFleetEdgeStatus() requests from alarm, startup,
// message handler, and fire-and-forget post-login all hitting backend at once.
const STATUS_CACHE_TTL_MS = 10_000; // 10s
let _statusPromise = null;
let _statusCacheTime = 0;

/**
 * Deduplicating wrapper around getFleetEdgeStatus().
 * Returns a cached result if called within STATUS_CACHE_TTL_MS.
 */
async function getCachedFleetEdgeStatus() {
  const now = Date.now();
  if (_statusPromise && (now - _statusCacheTime) < STATUS_CACHE_TTL_MS) {
    return _statusPromise;
  }
  _statusCacheTime = now;
  _statusPromise = getFleetEdgeStatus().catch((err) => {
    _statusPromise = null; // Clear on error so next call retries
    throw err;
  });
  return _statusPromise;
}

/** Invalidate the status cache (after connect/disconnect/logout/clear). */
function invalidateStatusCache() {
  _statusPromise = null;
  _statusCacheTime = 0;
}

// Initialize telemetry
startTelemetry();

logger.info('FleetEdge Fuel Monitor initialized (CWS-compliant, backend-direct)');

// ─── Status Polling ──────────────────────────────────────────────────────────
// Instead of the extension processing tasks, we just poll backend for status.

chrome.alarms.create('statusPoll', {
  delayInMinutes: 1,
  periodInMinutes: config.STATUS_POLL_INTERVAL_MINUTES,
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'statusPoll') {
    try {
      const authed = await isAuthenticated();
      if (authed) {
        await getCachedFleetEdgeStatus();
      }
    } catch {
      // Silently ignore — will retry next cycle
    }
  }
});

// Auto-check FleetEdge status on startup if authenticated
isAuthenticated().then(async (authed) => {
  if (authed) {
    logger.info('Already authenticated — checking FleetEdge status');
    try {
      await getCachedFleetEdgeStatus();
    } catch { /* startup check — non-critical, retried by alarm */ }
  }
}).catch(() => { /* guard against isAuthenticated rejection */ });

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages from content scripts that aren't meant for us
  if (message.type === 'READ_FLEETEDGE_TOKEN') return false;

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
      tlog.info('Login requested');
      const result = await login(emailOrMobile, password);
      // Fire-and-forget status check (getCached handles errors internally)
      getCachedFleetEdgeStatus().catch(() => {});
      return { success: true, user: result.user };
    }

    case 'LOGOUT': {
      tlog.info('Logout requested');
      await logout();
      invalidateStatusCache();
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
        'authToken', 'authUser', 'backendUrl',
        'fleetEdgeStatus', 'fleetEdgeFleetId', 'fleetEdgeExp',
        'fleetEdgeVehicleCount', 'fleetEdgeLinkedAt',
      ]);

      const cachedFe = {
        status: store.fleetEdgeStatus || 'unknown',
        fleetId: store.fleetEdgeFleetId || null,
        remainingSeconds: 0,
      };

      // Parallel fetch: metrics + (backend status + FleetEdge status) if authenticated
      const [metrics, backendStatus, feStatus] = await Promise.all([
        getMetrics(),
        store.authToken
          ? fetchStatus().then(r => r.data).catch(() => null)
          : Promise.resolve(null),
        store.authToken
          ? getCachedFleetEdgeStatus().catch(() => cachedFe)
          : Promise.resolve(cachedFe),
      ]);

      return {
        authenticated: !!store.authToken,
        user: store.authUser || null,
        backendUrl: store.backendUrl || null,
        fleetEdge: {
          status: feStatus.status,
          fleetId: feStatus.fleetId || store.fleetEdgeFleetId || null,
          remainingSeconds: feStatus.remainingSeconds || 0,
          vehicleCount: feStatus.vehicleCount || store.fleetEdgeVehicleCount || 0,
          linkedAt: store.fleetEdgeLinkedAt || null,
        },
        backendStatus,
        metrics,
      };
    }

    case 'SET_BACKEND_URL': {
      if (!message.url) throw new Error('URL is required');
      // Validate URL format before storing
      try { new URL(message.url); } catch { throw new Error('Invalid URL format'); }
      await setStorage({ backendUrl: message.url });
      invalidateStatusCache();
      logger.info(`Backend URL updated: ${message.url}`);
      return { success: true };
    }

    // ─── FleetEdge Connection ──────────────────────────────────────────

    case 'CONNECT_FLEETEDGE': {
      tlog.info('FleetEdge connect requested');
      invalidateStatusCache();
      const result = await connectFleetEdge();
      return result;
    }

    case 'DISCONNECT_FLEETEDGE': {
      tlog.info('FleetEdge disconnect requested');
      const result = await disconnectFleetEdge();
      invalidateStatusCache();
      return result;
    }

    case 'GET_FLEETEDGE_STATUS': {
      const status = await getCachedFleetEdgeStatus();
      return status;
    }

    // ─── Trigger backend processing (optional manual trigger) ──────────

    case 'TRIGGER_PROCESS': {
      taskTel.info('Manual process trigger requested');
      try {
        const response = await backendFetch('/fleetedge/process-tasks', { method: 'POST' });
        const data = await response.json();
        taskTel.info('Process trigger completed', {
          tasksProcessed: data.data?.tasksProcessed,
          results: data.data?.results?.length,
        });
        return { success: true, result: data.data };
      } catch (err) {
        taskTel.error('Process trigger failed', { error: err.message });
        return { success: false, error: err.message };
      }
    }

    // ─── Logs ──────────────────────────────────────────────────────────

    case 'GET_LOGS': {
      const logs = await getLogs(message.limit || 100);
      return { logs };
    }

    case 'CLEAR_LOGS': {
      await clearLogs();
      return { success: true };
    }

    // ─── Data Management ───────────────────────────────────────────────

    case 'CLEAR_ALL': {
      // Disconnect FleetEdge on backend
      try {
        await disconnectFleetEdge();
      } catch { /* best-effort disconnect — proceed with clearing data */ }

      invalidateStatusCache();

      await removeStorage([
        'authToken', 'authUser', 'backendUrl',
        'fleetEdgeStatus', 'fleetEdgeFleetId', 'fleetEdgeExp',
        'fleetEdgeLinkedAt', 'fleetEdgeVehicleCount',
        'metrics',
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
