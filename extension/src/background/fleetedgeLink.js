/**
 * FleetEdge Link — Background Module (multi-account)
 * ────────────────────────────────────────────────────
 * Coordinates:
 *   1. Sends READ_FLEETEDGE_TOKEN to the content script on fleetedge.home.tatamotors
 *   2. Forwards the token to the backend (POST /fleetedge/link-token)
 *   3. Refreshes multi-account status from the backend
 *   4. Manages badge + expiry notifications per account
 */

import { createLogger } from './logger.js';
import { getStorage, setStorage, checkTokenExpiry, deriveAccountStatus } from './utils.js';
import { backendFetch } from './backendApi.js';
import { createLayerLogger, LAYERS } from './telemetry.js';

const logger = createLogger('FleetEdgeLink');
const tokenTel = createLayerLogger(LAYERS.TOKEN);
const feTel = createLayerLogger(LAYERS.FLEETEDGE);

const MIN_TOKEN_TTL_SECONDS = 600; // 10 minutes

// Track which accounts have already triggered a notification this session
const _notifiedExpiredAccounts = new Set();

// H-4: Serialize all read-modify-write flows touching FleetEdge account storage.
// Popup-driven connect/disconnect/rename and alarm-driven status refresh can
// otherwise interleave on chrome.storage.local and clobber each other.
let _linkChain = Promise.resolve();
export function withLinkLock(fn) {
  const next = _linkChain.then(fn, fn);
  _linkChain = next.catch(() => {});
  return next;
}

// H-3: Local JWT payload decode for sanity-checking owner identity only — no
// signature verification (extension cannot hold the signing key).
function decodeJwtPayloadUnsafe(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4 ? '='.repeat(4 - (base64.length % 4)) : '';
    const jsonStr = atob(base64 + pad);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

function updateBadge(accounts) {
  if (!accounts.length) {
    chrome.action.setBadgeText({ text: '' });
    return;
  }
  const now = Date.now();
  let expired = 0,
    expiring = 0;
  for (const a of accounts) {
    const s = deriveAccountStatus(a, now);
    if (s === 'expired') expired++;
    else if (s === 'expiring') expiring++;
  }
  if (expired > 0) {
    chrome.action.setBadgeText({ text: String(expired) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else if (expiring > 0) {
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
  } else {
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
  }
}

function notifyExpiredAccounts(accounts) {
  const now = Date.now();
  for (const acc of accounts) {
    const s = deriveAccountStatus(acc, now);
    if (s === 'expired' && !_notifiedExpiredAccounts.has(acc.accountId)) {
      _notifiedExpiredAccounts.add(acc.accountId);
      chrome.notifications.create(`fe-expired-${acc.accountId}`, {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'FleetEdge session expired',
        message: `Session for "${acc.friendlyName || acc.fleetId}" expired — open FleetEdge and reconnect.`,
      });
      feTel.warn('FleetEdge token expired — notification fired', { accountId: acc.accountId });
    } else if (s !== 'expired' && _notifiedExpiredAccounts.has(acc.accountId)) {
      _notifiedExpiredAccounts.delete(acc.accountId);
    }
  }
}

/**
 * Read the FleetEdge token from a single tab, handling content-script retry.
 * Returns { success, token, fleetId, exp, foundIn, ... } or { success: false, error }.
 */
async function readTokenFromTab(tab) {
  let tokenResult;
  try {
    tokenResult = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FLEETEDGE_TOKEN' });
  } catch (err) {
    const isNoReceiver =
      err.message?.includes('Could not establish connection') ||
      err.message?.includes('Receiving end does not exist');
    if (isNoReceiver) {
      logger.info('Content script not ready — reloading FleetEdge tab and retrying...');
      chrome.tabs.reload(tab.id);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        tokenResult = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FLEETEDGE_TOKEN' });
      } catch (retryErr) {
        tokenTel.error('Content script communication failed after retry', {
          tabId: tab.id,
          reason: retryErr.message,
        });
        return {
          success: false,
          error: 'Could not communicate with FleetEdge page after refresh — please try again',
        };
      }
    } else {
      tokenTel.error('Content script communication failed', { tabId: tab.id, reason: err.message });
      return {
        success: false,
        error: 'Could not communicate with FleetEdge page — try refreshing the FleetEdge tab',
      };
    }
  }

  if (!tokenResult || !tokenResult.success) {
    return {
      success: false,
      error:
        tokenResult?.error || 'Could not read FleetEdge token — please log in to FleetEdge first',
    };
  }

  return { success: true, ...tokenResult };
}

/**
 * Capture a token from open FleetEdge tabs.
 *
 * G-1: On fresh connect (no targetTabId), if multiple tabs are open, return a
 * picker payload so the popup can let the user choose — option (a). Each
 * candidate is decoded to surface the account name without guessing which tab
 * to use. If targetTabId is provided (second call after picker), read only that
 * exact tab.
 */
async function captureTabToken({ targetTabId = null, expectedFleetId = null } = {}) {
  const hasPermission = await chrome.permissions.contains({
    origins: ['https://fleetedge.home.tatamotors/*'],
  });
  if (!hasPermission) {
    return {
      success: false,
      error: 'Fleet portal access not yet allowed — click Connect to grant permission first',
    };
  }

  const tabs = await chrome.tabs.query({ url: 'https://fleetedge.home.tatamotors/*' });
  if (!tabs.length) {
    tokenTel.warn('No FleetEdge tab found');
    return {
      success: false,
      error: 'No FleetEdge tab open — please open FleetEdge and log in first',
    };
  }

  // G-1: If caller specified a tab (picker result) use it directly.
  // Otherwise, if >1 tab open and this is a fresh connect, return choices.
  if (!targetTabId && !expectedFleetId && tabs.length > 1) {
    // Decode each tab's JWT to build a picker list (best-effort; tabs that fail are included with null name).
    const choices = await Promise.all(
      tabs.map(async (t) => {
        try {
          const res = await chrome.tabs.sendMessage(t.id, { type: 'READ_FLEETEDGE_TOKEN' });
          if (res && res.success) {
            const payload = decodeJwtPayloadUnsafe(res.token);
            const name = payload?.name || payload?.sub || null;
            return { tabId: t.id, fleetId: res.fleetId || null, displayName: name || res.fleetId || `Tab ${t.id}` };
          }
        } catch {
          /* tab not ready — include as unknown */
        }
        return { tabId: t.id, fleetId: null, displayName: `Tab ${t.id}` };
      })
    );
    tokenTel.warn('Multiple FleetEdge tabs — returning picker', { count: tabs.length });
    // Return structured picker response; popup will re-invoke with { tabId }.
    return { success: false, needsTabPick: true, choices };
  }

  // Resolve the single tab to use.
  let tab;
  if (targetTabId) {
    tab = tabs.find((t) => t.id === targetTabId);
    if (!tab) {
      return { success: false, error: 'Selected tab no longer open — please try again' };
    }
  } else if (tabs.length === 1) {
    tab = tabs[0];
  } else {
    // expectedFleetId is set (reconnect path) — fall back to most-recent; H-3 guard below handles mismatch.
    tab = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }

  const tokenResult = await readTokenFromTab(tab);
  if (!tokenResult.success) return tokenResult;

  // G-2: Defensive fleet_id match — refuse if the tab's JWT owner doesn't match
  // the connect/reconnect intent. Guards against silently cross-linking accounts.
  if (expectedFleetId) {
    const payload = decodeJwtPayloadUnsafe(tokenResult.token);
    const claimFleetId =
      payload && (payload.fleet_id || payload.fleetId)
        ? String(payload.fleet_id || payload.fleetId)
        : null;
    const tokenFleetId = claimFleetId || (tokenResult.fleetId ? String(tokenResult.fleetId) : null);
    if (tokenFleetId && String(expectedFleetId) !== tokenFleetId) {
      tokenTel.warn('Tab JWT fleet_id mismatch — refusing token read', {
        expectedFleetId: String(expectedFleetId),
        tokenFleetId,
        tabId: tab.id,
      });
      return {
        success: false,
        error:
          'FleetEdge tab is logged into a different account — switch FleetEdge to the account you want to reconnect and try again',
      };
    }
  }

  tokenTel.info('Token read from content script', {
    foundIn: tokenResult.foundIn,
    fleetId: tokenResult.fleetId,
    hasExp: !!tokenResult.exp,
  });

  if (tokenResult.exp) {
    const { valid, remainingSeconds } = checkTokenExpiry(
      { exp: tokenResult.exp },
      MIN_TOKEN_TTL_SECONDS
    );
    if (!valid) {
      const minutes = Math.max(0, Math.floor(remainingSeconds / 60));
      tokenTel.warn('Token too close to expiry', {
        remainingSeconds,
        fleetId: tokenResult.fleetId,
      });
      return {
        success: false,
        error: `FleetEdge token expires in ${minutes} min — please refresh FleetEdge and try again`,
      };
    }
  }

  return { success: true, ...tokenResult };
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Connect a new FleetEdge account (captures token from open tab, links to backend).
 * opts.tabId — if provided, skip the tab picker and read this specific tab (G-1 second pass).
 */
export async function connectFleetEdge(opts = {}) {
  return withLinkLock(() => _connectFleetEdgeInner(opts));
}

async function _connectFleetEdgeInner({ expectedFleetId = null, expectedAccountId = null, tabId = null } = {}) {
  logger.info('Connecting to FleetEdge...');
  feTel.perfStart('connect');

  const captured = await captureTabToken({ targetTabId: tabId, expectedFleetId });

  // G-1: Propagate the multi-tab picker response up to the popup unchanged.
  if (!captured.success && captured.needsTabPick) {
    feTel.perfEnd('connect');
    return captured;
  }

  if (!captured.success) {
    feTel.perfEnd('connect');
    return captured;
  }

  // H-3: For reconnect flows we know which stored account the user is targeting.
  // captureTabToken already enforced the expectedFleetId match for the tab read,
  // but double-check here for belt-and-suspenders when the tab picker was used.
  if (expectedFleetId && !tabId) {
    const payload = decodeJwtPayloadUnsafe(captured.token);
    const claimFleetId =
      payload && (payload.fleet_id || payload.fleetId)
        ? String(payload.fleet_id || payload.fleetId)
        : null;
    const tokenFleetId = claimFleetId || (captured.fleetId ? String(captured.fleetId) : null);
    if (tokenFleetId && String(expectedFleetId) !== tokenFleetId) {
      feTel.warn('Reconnect aborted — JWT owner does not match requested account', {
        expectedFleetId: String(expectedFleetId),
        tokenFleetId,
        expectedAccountId,
      });
      feTel.perfEnd('connect');
      return {
        success: false,
        error:
          'FleetEdge tab is logged into a different account — switch FleetEdge to the account you want to reconnect and try again',
      };
    }
  }

  try {
    const response = await backendFetch('/fleetedge/link-token', {
      method: 'POST',
      body: JSON.stringify({ token: captured.token, fleetId: captured.fleetId }),
    });
    const data = await response.json();
    const result = data.data;

    // Refresh full accounts list (already inside the link lock)
    const status = await _getFleetEdgeStatusInner();

    logger.info(`FleetEdge linked: ${result.vehicleCount} vehicles`);
    feTel.info('FleetEdge linked', {
      accountId: result.accountId,
      vehicleCount: result.vehicleCount,
    });
    feTel.perfEnd('connect');

    return {
      success: true,
      accountId: result.accountId,
      vehicleCount: result.vehicleCount,
      expiresAt: result.expiresAt,
      accounts: status.accounts || [],
    };
  } catch (err) {
    logger.error('Failed to link token:', err.message);
    feTel.error('Link token to backend failed', { error: err.message });
    feTel.perfEnd('connect');
    return { success: false, error: err.message };
  }
}

/**
 * Reconnect a specific account (same capture flow, backend upserts by userId+accountId).
 */
export async function reconnectFleetEdgeAccount(accountId) {
  logger.info(`Reconnecting account ${accountId}`);
  // Look up the expected fleetId from local storage so connect can refuse the
  // token if the FleetEdge tab is logged into a different account (H-3).
  const store = await getStorage(['fleetEdgeAccounts']);
  const account = (store.fleetEdgeAccounts || []).find((a) => a.accountId === accountId);
  if (!account) {
    feTel.warn('Reconnect requested for unknown account', { accountId });
    return { success: false, error: 'Account not found — try refreshing the popup' };
  }
  return connectFleetEdge({
    expectedFleetId: account.fleetId,
    expectedAccountId: accountId,
  });
}

/**
 * Disconnect a specific account. Null disconnects all.
 */
export async function disconnectFleetEdgeAccount(accountId) {
  return withLinkLock(async () => {
    try {
      await backendFetch('/fleetedge/unlink', {
        method: 'POST',
        body: accountId ? JSON.stringify({ accountId }) : undefined,
      });
    } catch (err) {
      logger.warn('Unlink API call failed:', err.message);
      feTel.warn('Unlink API call failed', { error: err.message });
    }

    if (accountId) {
      const store = await getStorage(['fleetEdgeAccounts']);
      const accounts = (store.fleetEdgeAccounts || []).filter((a) => a.accountId !== accountId);
      await setStorage({ fleetEdgeAccounts: accounts });
      updateBadge(accounts);
      _notifiedExpiredAccounts.delete(accountId);
    } else {
      await setStorage({ fleetEdgeAccounts: [], fleetEdgePull: null });
      chrome.action.setBadgeText({ text: '' });
      _notifiedExpiredAccounts.clear();
    }

    feTel.info('FleetEdge disconnected', { accountId });
    return { success: true };
  });
}

/**
 * Disconnect all accounts (used by clearData / CLEAR_ALL).
 */
export async function disconnectFleetEdge() {
  return disconnectFleetEdgeAccount(null);
}

/**
 * Reset in-memory notification tracking (called by CLEAR_ALL so a new session
 * doesn't suppress notifications for the next user on this Chrome profile).
 */
export function resetNotifiedAccounts() {
  _notifiedExpiredAccounts.clear();
}

/**
 * Rename an account in local storage (optimistic).
 */
export async function renameFleetEdgeAccount(accountId, friendlyName) {
  return withLinkLock(async () => {
    const store = await getStorage(['fleetEdgeAccounts']);
    const accounts = (store.fleetEdgeAccounts || []).map((a) =>
      a.accountId === accountId ? { ...a, friendlyName } : a
    );
    await setStorage({ fleetEdgeAccounts: accounts });
    feTel.info('Account renamed', { accountId });
    return { success: true };
  });
}

/**
 * Fetch FleetEdge connection status from backend.
 * Returns { accounts: [...], pull: {...} }
 */
export async function getFleetEdgeStatus() {
  return withLinkLock(_getFleetEdgeStatusInner);
}

async function _getFleetEdgeStatusInner() {
  try {
    const response = await backendFetch('/fleetedge/status');
    const data = await response.json();
    const status = data.data || {};
    const accounts = status.accounts || [];
    const pull = status.pull || {};

    await setStorage({ fleetEdgeAccounts: accounts, fleetEdgePull: pull });
    updateBadge(accounts);
    notifyExpiredAccounts(accounts);

    feTel.debug('FleetEdge status fetched', { accountCount: accounts.length });
    return { accounts, pull };
  } catch (err) {
    feTel.warn('Status check failed, using cache', { error: err.message });
    const store = await getStorage(['fleetEdgeAccounts', 'fleetEdgePull']);
    return {
      accounts: store.fleetEdgeAccounts || [],
      pull: store.fleetEdgePull || {},
    };
  }
}
