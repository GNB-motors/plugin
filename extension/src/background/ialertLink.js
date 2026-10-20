/**
 * iALERT Link — Background Module
 * ────────────────────────────────
 * Coordinates:
 *   1. Opens iALERT for sign-in (capture scripts are manifest-declared)
 *   2. Links captured session to backend (POST /extension/ialert/link-token)
 *   3. Forwards token rotations to backend
 *   4. Manages iALERT account status
 */

import { createLogger } from './logger.js';
import { getStorage, setStorage } from './utils.js';
import { backendFetch } from './backendApi.js';
import { createLayerLogger, LAYERS } from './telemetry.js';

const logger = createLogger('IalertLink');
const ialertTel = createLayerLogger(LAYERS.IALERT);

const IALERT_ORIGIN = 'https://ialert.ashokleyland.com';

// Storage keys for iALERT metadata (NEVER store tokens)
const IALERT_META_KEY = 'ialertMeta';

/**
 * Get stored iALERT metadata (no tokens)
 */
async function getIalertMeta() {
  const store = await getStorage([IALERT_META_KEY]);
  return store[IALERT_META_KEY] || null;
}

/**
 * Store iALERT metadata (tokenValue, ialertUserId only - no tokens)
 */
async function setIalertMeta(meta) {
  return setStorage({ [IALERT_META_KEY]: meta });
}

// H-4: Serialize all read-modify-write flows touching iALERT storage
let _linkChain = Promise.resolve();
export function withLinkLock(fn) {
  const next = _linkChain.then(fn, fn);
  _linkChain = next.catch(() => {});
  return next;
}

/**
 * "Connect iALERT": the capture scripts are declared in the manifest for
 * ialert.ashokleyland.com (P1 option (a)), so connecting is just opening
 * iALERT for the user to sign in — the login is what gets linked.
 * chrome.tabs.create needs no "tabs" permission.
 */
export async function openIalertForSignIn() {
  try {
    await chrome.tabs.create({ url: `${IALERT_ORIGIN}/` });
    ialertTel.info('Opened iALERT for sign-in');
    return { success: true };
  } catch (err) {
    ialertTel.error('Failed to open iALERT', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Link an iALERT session to the backend
 * @param {Object} session - { token, refreshToken, tokenValue, ialertUserId, ialertOwnerId }
 */
export async function linkIalertSession(session) {
  const { token, refreshToken, tokenValue, ialertUserId, ialertOwnerId } = session;

  return withLinkLock(async () => {
    try {
      ialertTel.info('Linking iALERT session to backend');
      const response = await backendFetch('/extension/ialert/link-token', {
        method: 'POST',
        body: JSON.stringify({
          token,
          refreshToken,
          tokenValue,
          ialertUserId,
          ialertOwnerId,
        }),
      });

      const data = await response.json();
      const result = data.data;

      // Store metadata (no tokens!)
      await setIalertMeta({
        tokenValue,
        ialertUserId,
        ialertOwnerId,
      });

      // Check for refreshRejected status
      const refreshRejected = result?.refreshRejected || null;
      let message = null;
      if (refreshRejected === 'TTL_UNMEASURED' || refreshRejected === 'NOT_CAPTURED') {
        message = 'Connected for this session; automatic renewal is not available yet';
      }

      logger.info(`iALERT linked: ${result.accountId || 'unknown'}`);
      ialertTel.info('iALERT linked', { accountId: result.accountId });

      return {
        success: true,
        accountId: result.accountId,
        message,
        refreshRejected,
      };
    } catch (err) {
      // Check for specific error code
      if (err.code === 'IALERT_TOKEN_TOO_OLD') {
        logger.warn('iALERT token too old:', err.message);
        ialertTel.warn('iALERT token too old', { error: err.message });
        return { success: false, error: err.message };
      }

      logger.error('Failed to link iALERT session:', err.message);
      ialertTel.error('iALERT link failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });
}

/**
 * Forward an iALERT token rotation to the backend
 * @param {Object} rotation - { token, refreshToken }
 */
export async function forwardIalertRotation(rotation) {
  const { token, refreshToken } = rotation;

  // Get stored metadata
  const meta = await getIalertMeta();
  if (!meta || !meta.tokenValue || !meta.ialertUserId) {
    // No stored session - skip silently
    ialertTel.debug('No stored iALERT metadata, skipping rotation forward');
    return { success: true, skipped: true };
  }

  try {
    await backendFetch('/extension/ialert/refresh-token-rotated', {
      method: 'POST',
      body: JSON.stringify({
        token,
        refreshToken,
        tokenValue: meta.tokenValue,
        ialertUserId: meta.ialertUserId,
      }),
    });

    ialertTel.info('iALERT token rotation forwarded to backend');
    return { success: true };
  } catch (err) {
    logger.error('Failed to forward iALERT rotation:', err.message);
    ialertTel.error('iALERT rotation forward failed', { error: err.message });
    return { success: false, error: err.message };
  }
}

/**
 * Refresh iALERT status from backend
 */
export async function refreshIalertStatus() {
  return withLinkLock(async () => {
    try {
      const response = await backendFetch('/extension/ialert/status');
      const data = await response.json();
      // GET /extension/ialert/status → { status, data: [row, …] } (backend B4
      // getStatus returns the rows array; rows carry no tokens).
      const accounts = Array.isArray(data?.data) ? data.data : [];

      await setStorage({ ialertAccounts: accounts });

      ialertTel.debug('iALERT status refreshed', { accountCount: accounts.length });
      return { success: true, accounts };
    } catch (err) {
      // Return cached on failure
      const store = await getStorage(['ialertAccounts']);
      ialertTel.warn('iALERT status fetch failed, using cache', { error: err.message });
      return {
        success: false,
        error: err.message,
        errorStatus: err.status ?? null,
        accounts: store.ialertAccounts || [],
      };
    }
  });
}

/**
 * Unlink an iALERT account
 * @param {string} accountId - Account ID to unlink, or null for all
 */
export async function unlinkIalert(accountId) {
  return withLinkLock(async () => {
    try {
      const path = accountId
        ? `/extension/ialert/unlink/${encodeURIComponent(accountId)}`
        : '/extension/ialert/unlink';

      await backendFetch(path, {
        method: 'POST',
        body: accountId ? undefined : JSON.stringify({ all: true }),
      });

      // Clear metadata if unlinking all
      if (!accountId) {
        await setIalertMeta(null);
        await setStorage({ ialertAccounts: [] });
      }

      logger.info(`iALERT unlinked: ${accountId || 'all'}`);
      ialertTel.info('iALERT unlinked', { accountId });
      return { success: true };
    } catch (err) {
      logger.error('Failed to unlink iALERT:', err.message);
      ialertTel.error('iALERT unlink failed', { error: err.message });
      return { success: false, error: err.message };
    }
  });
}
