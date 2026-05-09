/**
 * FleetEdge Link — Background Module
 * ────────────────────────────────────
 * Coordinates:
 *   1. Sends READ_FLEETEDGE_TOKEN to the content script on fleetedge.home.tatamotors
 *   2. Forwards the token to the backend (POST /fleetedge/link-token)
 *   3. Refreshes connection status from the backend
 *
 * This replaces tokenCapture.js (which used webRequest — CWS violation).
 *
 * LEMU Telemetry: TOKEN layer (content script token read), FLEETEDGE layer (link/status).
 */

import { createLogger } from './logger.js';
import { getStorage, setStorage, checkTokenExpiry } from './utils.js';
import { createLayerLogger, LAYERS } from './telemetry.js';

const logger = createLogger('FleetEdgeLink');
const tokenTel = createLayerLogger(LAYERS.TOKEN);
const feTel = createLayerLogger(LAYERS.FLEETEDGE);

/** Minimum remaining seconds a token must have before we send it to backend. */
const MIN_TOKEN_TTL_SECONDS = 600; // 10 minutes

/**
 * Attempt to read the FleetEdge token from an open FleetEdge tab
 * by messaging the content script, then send it to the backend.
 *
 * @returns {{ success: boolean, vehicleCount?: number, error?: string }}
 */
export async function connectFleetEdge() {
  logger.info('Connecting to FleetEdge...');
  feTel.perfStart('connect');

  // 1. Verify optional host permission is granted before querying tabs.
  const hasPermission = await chrome.permissions.contains({
    origins: ['https://fleetedge.home.tatamotors/*'],
  });
  if (!hasPermission) {
    const error = 'Fleet portal access not yet allowed — click Connect to grant permission first';
    logger.warn(error);
    feTel.perfEnd('connect');
    return { success: false, error };
  }

  // 2. Find an open FleetEdge tab
  const tabs = await chrome.tabs.query({ url: 'https://fleetedge.home.tatamotors/*' });
  if (!tabs.length) {
    const error = 'No FleetEdge tab open — please open FleetEdge and log in first';
    logger.warn(error);
    tokenTel.warn('No FleetEdge tab found');
    feTel.perfEnd('connect');
    return { success: false, error };
  }

  // Pick the most recently accessed tab (handles multiple FleetEdge tabs)
  const tab = tabs.length > 1
    ? tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0]
    : tabs[0];
  logger.info(`Found FleetEdge tab: ${tab.id}${tabs.length > 1 ? ` (picked from ${tabs.length} tabs)` : ''}`);

  // 2. Ask the content script to read the token; auto-refresh tab once if not injected yet
  let tokenResult;
  try {
    tokenResult = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FLEETEDGE_TOKEN' });
  } catch (err) {
    const isNoReceiver = err.message?.includes('Could not establish connection') ||
                         err.message?.includes('Receiving end does not exist');
    if (isNoReceiver) {
      logger.info('Content script not ready — reloading FleetEdge tab and retrying...');
      tokenTel.info('Reloading tab for content script injection', { tabId: tab.id });
      chrome.tabs.reload(tab.id);
      // Wait for the page to load and content script to inject (~3s)
      await new Promise((resolve) => setTimeout(resolve, 3000));
      try {
        tokenResult = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FLEETEDGE_TOKEN' });
      } catch (retryErr) {
        const error = 'Could not communicate with FleetEdge page after refresh — please try again';
        logger.error(error, retryErr.message);
        tokenTel.error('Content script communication failed after retry', { tabId: tab.id, reason: retryErr.message });
        feTel.perfEnd('connect');
        return { success: false, error };
      }
    } else {
      const error = 'Could not communicate with FleetEdge page — try refreshing the FleetEdge tab';
      logger.error(error, err.message);
      tokenTel.error('Content script communication failed', { tabId: tab.id, reason: err.message });
      feTel.perfEnd('connect');
      return { success: false, error };
    }
  }

  if (!tokenResult || !tokenResult.success) {
    const error = tokenResult?.error || 'Could not read FleetEdge token — please log in to FleetEdge first';
    logger.warn(error);
    tokenTel.warn('Token read failed', { error });
    feTel.perfEnd('connect');
    return { success: false, error };
  }

  tokenTel.info('Token read from content script', {
    foundIn: tokenResult.foundIn,
    fleetId: tokenResult.fleetId,
    hasExp: !!tokenResult.exp,
  });
  logger.info(`Token read from FleetEdge (found in: ${tokenResult.foundIn}), fleet: ${tokenResult.fleetId}`);

  // 2b. Validate token isn't about to expire (avoid wasting backend work)
  if (tokenResult.exp) {
    const { valid, remainingSeconds } = checkTokenExpiry({ exp: tokenResult.exp }, MIN_TOKEN_TTL_SECONDS);
    if (!valid) {
      const minutes = Math.max(0, Math.floor(remainingSeconds / 60));
      const error = `FleetEdge token expires in ${minutes} min — please refresh FleetEdge and try again`;
      logger.warn(error);
      tokenTel.warn('Token too close to expiry', { remainingSeconds, fleetId: tokenResult.fleetId });
      feTel.perfEnd('connect');
      return { success: false, error };
    }
  }

  // 3. Send to backend
  const { backendFetch } = await import('./backendApi.js');
  try {
    const response = await backendFetch('/fleetedge/link-token', {
      method: 'POST',
      body: JSON.stringify({
        token: tokenResult.token,
        fleetId: tokenResult.fleetId,
      }),
    });

    const data = await response.json();
    const result = data.data;

    // Store connection status locally for quick access
    await setStorage({
      fleetEdgeStatus: 'linked',
      fleetEdgeFleetId: tokenResult.fleetId,
      fleetEdgeExp: tokenResult.exp,
      fleetEdgeLinkedAt: Date.now(),
      fleetEdgeVehicleCount: result.vehicleCount || 0,
    });

    // Update badge
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });

    logger.info(`FleetEdge linked: ${result.vehicleCount} vehicles, expires ${new Date(tokenResult.exp * 1000).toISOString()}`);
    feTel.info('FleetEdge linked', {
      vehicleCount: result.vehicleCount,
      fleetId: tokenResult.fleetId,
      expiresAt: result.expiresAt,
    });
    feTel.perfEnd('connect');

    return {
      success: true,
      vehicleCount: result.vehicleCount,
      expiresAt: result.expiresAt,
    };
  } catch (err) {
    logger.error('Failed to send token to backend:', err.message);
    feTel.error('Link token to backend failed', { error: err.message });
    feTel.perfEnd('connect');
    return { success: false, error: err.message };
  }
}

/**
 * Fetch FleetEdge connection status from the backend.
 */
export async function getFleetEdgeStatus() {
  try {
    const { backendFetch } = await import('./backendApi.js');
    const response = await backendFetch('/fleetedge/status');
    const data = await response.json();
    const status = data.data;

    // Cache locally
    await setStorage({
      fleetEdgeStatus: status.status,
      fleetEdgeFleetId: status.fleetId || null,
    });

    // Update badge based on status
    if (status.status === 'linked') {
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
    } else if (status.status === 'expired') {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      feTel.warn('FleetEdge token expired', { fleetId: status.fleetId });
    }

    feTel.debug('Status check OK', { status: status.status });
    return status;
  } catch (err) {
    feTel.warn('Status check failed, using cache', { error: err.message });
    // If backend unreachable, return cached status
    const store = await getStorage(['fleetEdgeStatus', 'fleetEdgeFleetId']);
    return {
      status: store.fleetEdgeStatus || 'unknown',
      fleetId: store.fleetEdgeFleetId || null,
      error: err.message,
    };
  }
}

/**
 * Disconnect FleetEdge (tell backend to delete stored token).
 */
export async function disconnectFleetEdge() {
  try {
    const { backendFetch } = await import('./backendApi.js');
    await backendFetch('/fleetedge/unlink', { method: 'POST' });
  } catch (err) {
    logger.warn('Unlink API call failed:', err.message);
    feTel.warn('Unlink API call failed', { error: err.message });
  }

  // Clear local state regardless
  await setStorage({
    fleetEdgeStatus: 'unlinked',
    fleetEdgeFleetId: null,
    fleetEdgeExp: null,
    fleetEdgeLinkedAt: null,
    fleetEdgeVehicleCount: null,
  });

  chrome.action.setBadgeText({ text: '' });
  logger.info('FleetEdge disconnected');
  feTel.info('FleetEdge disconnected');
  return { success: true };
}
