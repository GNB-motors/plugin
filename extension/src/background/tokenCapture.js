import { decodeJwtPayload, redactToken, setStorage, getStorage } from './utils.js';
import { config } from './config.js';
import { createLogger } from './logger.js';

const logger = createLogger('TokenCapture');

let lastNotificationAt = 0;
const NOTIFICATION_COOLDOWN_MS = 5 * 60 * 1000;

export function initTokenCapture() {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    handleRequest,
    { urls: ['https://cvp.api.tatamotors/api/vehicle-service/*'] },
    ['requestHeaders', 'extraHeaders']
  );

  logger.info('Token capture listener registered');
}

function handleRequest(details) {
  const authHeader = details.requestHeaders?.find(
    h => h.name.toLowerCase() === 'authorization'
  );

  if (!authHeader?.value?.startsWith('Bearer ')) return;

  const token = authHeader.value.slice(7);

  try {
    const payload = decodeJwtPayload(token);
    const fleetId = payload.fleet_id;
    const exp = payload.exp;

    if (!fleetId) {
      logger.warn('JWT missing fleet_id, ignoring');
      return;
    }

    setStorage({
      fleetToken: token,
      fleetId,
      tokenExp: exp,
      tokenCapturedAt: Date.now(),
    });

    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });

    logger.info(`Token captured, fleet: ${fleetId}, token: ${redactToken(token)}`);
  } catch (err) {
    logger.error('Failed to decode JWT:', err.message);
  }
}

export async function getValidToken(bufferSeconds = config.TOKEN_EXPIRY_BUFFER_SECONDS) {
  const store = await getStorage(['fleetToken', 'fleetId', 'tokenExp']);

  if (!store.fleetToken || !store.fleetId || !store.tokenExp) {
    return { valid: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const remaining = store.tokenExp - now;

  if (remaining <= bufferSeconds) {
    logger.warn(`Token expired or expiring soon (${remaining}s remaining)`);

    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });

    const canNotify = Date.now() - lastNotificationAt > NOTIFICATION_COOLDOWN_MS;
    if (canNotify) {
      lastNotificationAt = Date.now();
      chrome.notifications.create('token-expired', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'FleetEdge Session Expired',
        message: 'Please open FleetEdge and log in to continue processing tasks.',
        priority: 2,
      });
    }

    return { valid: false };
  }

  return {
    valid: true,
    token: store.fleetToken,
    fleetId: store.fleetId,
    remainingSeconds: remaining,
  };
}
