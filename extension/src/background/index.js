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

import {
  connectFleetEdge,
  getFleetEdgeStatus,
  disconnectFleetEdge,
  disconnectFleetEdgeAccount,
  reconnectFleetEdgeAccount,
  renameFleetEdgeAccount,
  resetNotifiedAccounts,
  pushRotatedRefreshToken,
  completeFleetEdgeLink,
} from './fleetedgeLink.js';
import {
  connectIalert,
  trackIalertTab,
  untrackIalertTab,
  linkIalertSession,
  forwardIalertRotation,
  refreshIalertStatus,
  unlinkIalert,
} from './ialertLink.js';
import { getStorage, setStorage, removeStorage } from './utils.js';
import { getLogs, clearLogs, createLogger } from './logger.js';
import { login, logout, isAuthenticated, backendFetch, fetchStatus } from './backendApi.js';
import {
  startTelemetry,
  record,
  LAYERS,
  createLayerLogger,
  getEvents,
  clearEvents,
  getStats,
  getHealthSnapshot,
  getBreadcrumbs,
} from './telemetry.js';
import { config } from './config.js';

const logger = createLogger('ServiceWorker');
const tlog = createLayerLogger(LAYERS.MESSAGE);
const ialertTel = createLayerLogger(LAYERS.IALERT);
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
  if (_statusPromise && now - _statusCacheTime < STATUS_CACHE_TTL_MS) {
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

// ─── TRIGGER_PROCESS cooldown ────────────────────────────────────────────────
// Rate-limit manual "Pull Now" triggers (RL-1). Stored in module scope so the
// cooldown persists for the life of the service worker. A second click inside
// config.TRIGGER_COOLDOWN_MS returns the cached prior result instead of
// re-hitting the backend.
let _lastTriggerAt = 0;
let _lastTriggerResult = null;
function resetTriggerCooldownState() {
  _lastTriggerAt = 0;
  _lastTriggerResult = null;
}

// Initialize telemetry
startTelemetry();

logger.info('FleetEdge Fuel Monitor initialized (CWS-compliant, backend-direct)');

// ─── Status Polling ──────────────────────────────────────────────────────────
// Instead of the extension processing tasks, we just poll backend for status.

// Jitter the poll period ±25% so multiple installs in the same org don't
// hammer the backend (and downstream FleetEdge) on identical minute boundaries
// — FleetEdge WAF would otherwise fingerprint the exact cadence as automation.
const _pollBase = config.STATUS_POLL_INTERVAL_MINUTES;
const _pollPeriodMinutes = _pollBase * (0.75 + Math.random() * 0.5);
chrome.alarms.create('statusPoll', {
  delayInMinutes: 1,
  periodInMinutes: _pollPeriodMinutes,
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
isAuthenticated()
  .then(async (authed) => {
    if (authed) {
      logger.info('Already authenticated — checking FleetEdge status');
      try {
        await getCachedFleetEdgeStatus();
      } catch {
        /* startup check — non-critical, retried by alarm */
      }
    }
  })
  .catch(() => {
    /* guard against isAuthenticated rejection */
  });

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages from content scripts that aren't meant for us
  if (message.type === 'READ_FLEETEDGE_TOKEN') return false;

  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      logger.error('Message handler error', err.message);
      sendResponse({ error: err.message });
    });
  return true;
});

// ─── External Message Handler ────────────────────────────────────────────────
// Allows the onboarding flow on app.gnbedge.in (and dev) to detect the
// extension via chrome.runtime.sendMessage(EXTENSION_ID, { type: 'PING' }).
// Only origins listed in manifest "externally_connectable.matches" can reach
// this listener. No authentication state is exposed.
chrome.runtime.onMessageExternal.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'PING') {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
    });
    return;
  }
  sendResponse({ ok: false, error: 'unsupported_message_type' });
});

/** Exact-origin check for content-script messages (no prefix match). */
function isSenderFrom(sender, origin) {
  try {
    return new URL(sender?.url || '').origin === origin;
  } catch {
    return false;
  }
}
const isIalertSender = (sender) => isSenderFrom(sender, 'https://ialert.ashokleyland.com');
const isFleetEdgeSender = (sender) => isSenderFrom(sender, 'https://fleetedge.home.tatamotors');

// A closed tab can no longer be asked for an iALERT session.
chrome.tabs.onRemoved.addListener((tabId) => {
  untrackIalertTab(tabId).catch(() => {});
});

async function handleMessage(message, sender) {
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
      resetTriggerCooldownState();
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
        'authToken',
        'authUser',
        'backendUrl',
        'fleetEdgeAccounts',
        'fleetEdgePull',
      ]);

      const cachedFe = {
        accounts: store.fleetEdgeAccounts || [],
        pull: store.fleetEdgePull || {},
      };

      // Parallel fetch: backend status + FleetEdge status if authenticated
      const [backendStatus, feStatus] = await Promise.all([
        store.authToken
          ? fetchStatus()
              .then((r) => r.data)
              .catch(() => null)
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
          accounts: feStatus.accounts || [],
          pull: {
            lastRunAt: feStatus.pull?.lastRunAt || backendStatus?.pullStatus?.lastRunAt || null,
            nextRunAt: feStatus.pull?.nextRunAt || backendStatus?.pullStatus?.nextRunAt || null,
            pullingNow: (backendStatus?.inProgress ?? 0) > 0,
          },
        },
        metrics: {
          pending: backendStatus?.pending ?? 0,
          inProgress: backendStatus?.inProgress ?? 0,
          completed: backendStatus?.completed ?? 0,
          flagged: backendStatus?.flagged ?? 0,
          noData: backendStatus?.noData ?? 0,
        },
        backendStatus,
      };
    }

    case 'SET_BACKEND_URL': {
      if (!message.url) throw new Error('URL is required');
      // Validate URL format before storing
      try {
        new URL(message.url);
      } catch {
        throw new Error('Invalid URL format');
      }
      await setStorage({ backendUrl: message.url });
      invalidateStatusCache();
      logger.info(`Backend URL updated: ${message.url}`);
      return { success: true };
    }

    // ─── FleetEdge Connection ──────────────────────────────────────────

    case 'CONNECT_FLEETEDGE': {
      tlog.info('FleetEdge connect requested');
      invalidateStatusCache();
      // G-1: pass tabId if popup supplied one from the tab picker (second-pass connect).
      const result = await connectFleetEdge({ tabId: message.tabId || null });
      return result;
    }

    case 'DISCONNECT_FLEETEDGE': {
      tlog.info('FleetEdge disconnect all requested');
      const result = await disconnectFleetEdge();
      invalidateStatusCache();
      return result;
    }

    case 'RECONNECT_ACCOUNT': {
      const { accountId } = message;
      if (!accountId) throw new Error('accountId is required');
      tlog.info('FleetEdge account reconnect requested', { accountId });
      invalidateStatusCache();
      const result = await reconnectFleetEdgeAccount(accountId);
      return result;
    }

    case 'DISCONNECT_ACCOUNT': {
      const { accountId } = message;
      if (!accountId) throw new Error('accountId is required');
      tlog.info('FleetEdge account disconnect requested', { accountId });
      const result = await disconnectFleetEdgeAccount(accountId);
      invalidateStatusCache();
      return result;
    }

    case 'RENAME_ACCOUNT': {
      const { accountId, friendlyName } = message;
      if (!accountId || !friendlyName) throw new Error('accountId and friendlyName are required');
      return renameFleetEdgeAccount(accountId, friendlyName);
    }

    case 'GET_FLEETEDGE_STATUS': {
      const status = await getCachedFleetEdgeStatus();
      return status;
    }

    case 'FLEETEDGE_LINK_DONE': {
      // The FleetEdge tab's "connected, closing in 5 s" countdown ended.
      // completeFleetEdgeLink() only acts when a link just asked for it.
      if (sender.id !== chrome.runtime.id || !isFleetEdgeSender(sender)) {
        return { success: false, error: 'Invalid sender' };
      }
      return completeFleetEdgeLink();
    }

    case 'FLEETEDGE_REFRESH_ROTATED': {
      // Content script intercepted a browser-side refresh-token rotation.
      // Single-use tokens: push it so the backend's copy stays current.
      return pushRotatedRefreshToken(message.fleetId, message.refreshToken);
    }

    // ─── iALERT Connection ──────────────────────────────────────────

    case 'IALERT_SESSION_CAPTURED': {
      // Verify sender is our extension
      if (sender.id !== chrome.runtime.id) {
        ialertTel.warn('IALERT_SESSION_CAPTURED rejected: wrong sender id');
        return { success: false, error: 'Invalid sender' };
      }
      // Verify sender is from iALERT origin
      if (!isIalertSender(sender)) {
        ialertTel.warn('IALERT_SESSION_CAPTURED rejected: wrong origin');
        return { success: false, error: 'Invalid origin' };
      }
      tlog.info('iALERT session captured');
      const linked = await linkIalertSession(message.session);
      if (linked.success) {
        try {
          chrome.notifications.create('gnb-ialert-linked', {
            type: 'basic',
            iconUrl: 'icons/icon48.png',
            title: 'iALERT connected',
            message: linked.refreshStored
              ? 'GNB Edge is now receiving your iALERT vehicles. You can close the iALERT tab.'
              : 'GNB Edge is now receiving your iALERT vehicles. When the extension shows Reconnect needed, sign in to iALERT again.',
          });
        } catch {
          // notifications are a convenience only
        }
      }
      return linked;
    }

    case 'IALERT_TAB_READY': {
      // An iALERT page loaded: remember its tab so Connect can ask it later.
      if (sender.id !== chrome.runtime.id || !isIalertSender(sender)) {
        return { success: false, error: 'Invalid sender' };
      }
      await trackIalertTab(sender.tab?.id);
      return { success: true };
    }

    case 'IALERT_TOKEN_ROTATED': {
      // Verify sender is our extension
      if (sender.id !== chrome.runtime.id) {
        ialertTel.warn('IALERT_TOKEN_ROTATED rejected: wrong sender id');
        return { success: false, error: 'Invalid sender' };
      }
      // Verify sender is from iALERT origin
      if (!isIalertSender(sender)) {
        ialertTel.warn('IALERT_TOKEN_ROTATED rejected: wrong origin');
        return { success: false, error: 'Invalid origin' };
      }
      tlog.info('iALERT token rotated');
      return forwardIalertRotation({ token: message.token, refreshToken: message.refreshToken });
    }

    case 'IALERT_ENABLE': {
      tlog.info('iALERT connect requested');
      return connectIalert();
    }

    case 'IALERT_STATUS': {
      const status = await refreshIalertStatus();
      return {
        enabled: true,
        accounts: status.accounts || [],
        error: status.success ? null : status.error,
        errorStatus: status.success ? null : status.errorStatus,
      };
    }

    case 'IALERT_UNLINK': {
      tlog.info('iALERT unlink requested');
      return unlinkIalert(message.accountId || null);
    }

    // ─── Trigger backend processing (optional manual trigger) ──────────

    case 'TRIGGER_PROCESS': {
      // Server-side cooldown: refuse repeat triggers inside TRIGGER_COOLDOWN_MS
      // so popup-spam (RL-1) can't fan out to backend → FleetEdge WAF.
      const nowMs = Date.now();
      const sinceLast = nowMs - _lastTriggerAt;
      if (sinceLast < config.TRIGGER_COOLDOWN_MS) {
        const retryInMs = config.TRIGGER_COOLDOWN_MS - sinceLast;
        taskTel.warn('Manual process trigger rejected (cooldown)', { retryInMs });
        if (_lastTriggerResult) {
          return { ..._lastTriggerResult, cached: true, retryInMs };
        }
        return { success: false, error: 'cooldown', retryInMs };
      }
      _lastTriggerAt = nowMs;
      taskTel.info('Manual process trigger requested');
      try {
        const response = await backendFetch('/fleetedge/process-tasks', { method: 'POST' });
        const data = await response.json();
        taskTel.info('Process trigger completed', {
          tasksProcessed: data.data?.tasksProcessed,
          results: data.data?.results?.length,
        });
        _lastTriggerResult = { success: true, result: data.data };
        return _lastTriggerResult;
      } catch (err) {
        taskTel.error('Process trigger failed', { error: err.message });
        // Don't cache failures — let the next call (after cooldown) retry fresh.
        _lastTriggerResult = null;
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
      // G-3: Remove the full explicit set of storage keys so no residue is
      // left when a shared Chrome profile switches users. Using an explicit
      // list is intentional — safer than a runtime enumerate-and-clear approach.
      // Local only. The org's FleetEdge link on the backend is shared by every
      // user and feeds the whole fleet; clearing one browser (a shared Chrome
      // switching users) used to revoke it and stop the data (prod BD
      // 2026-10-09). Disconnecting stays an explicit popup action.

      invalidateStatusCache();
      resetTriggerCooldownState();

      // G-3: Reset in-memory notification set so the next user's session starts clean.
      resetNotifiedAccounts();

      await removeStorage([
        'authToken',
        'authUser',
        'backendUrl',
        'fleetEdgeAccounts',
        'fleetEdgePull',
        'fleetEdgeStatus',
        'metrics',
        '_lastTriggerAt',
        // iALERT: link metadata + cached account rows belong to this GNB user.
        'ialertMeta',
        'ialertAccounts',
      ]);
      // G-3: Explicitly clear badge text (disconnectFleetEdge may not run if backend
      // call fails, so we force-clear here).
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
