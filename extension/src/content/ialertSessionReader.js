/**
 * iALERT Session Reader (ISOLATED World)
 * ───────────────────────────────────────
 * Receives the live session data intercepted by the MAIN world ialertSessionSpy.js
 * via window.postMessage.
 *
 * Keeps the freshest session by comparing the 10-digit epoch prefix of tokenValue.
 */

import { showGnbBanner } from './gnbBanner.js';
import {
  ialertConnectingBanner,
  ialertLinkedBanner,
  ialertFailureBanner,
} from '../shared/linkBanners.js';

const IALERT_ORIGIN = 'https://ialert.ashokleyland.com';

// Store the freshest session (keyed by tokenValue epoch prefix)
let cachedSession = null;
let cachedRotation = null;

// Extract 10-digit epoch prefix from tokenValue (first 10 digits)
function getEpochPrefix(tokenValue) {
  if (!tokenValue || typeof tokenValue !== 'string') return null;
  const match = tokenValue.match(/^(\d{10})/);
  return match ? match[1] : null;
}

// Check if new session is fresher than cached
function isFresher(newTokenValue) {
  if (!cachedSession) return true;
  const newPrefix = getEpochPrefix(newTokenValue);
  const oldPrefix = getEpochPrefix(cachedSession.tokenValue);
  // Can't compare by login time: accept anything that is a different session.
  if (!newPrefix || !oldPrefix) return newTokenValue !== cachedSession.tokenValue;
  return parseInt(newPrefix, 10) > parseInt(oldPrefix, 10);
}

// Listen for messages from the MAIN world spy script
window.addEventListener('message', (event) => {
  // Same-window check: reject messages from frames / cross-window sources
  if (event.source !== window) return;
  // Origin check: reject forged messages
  if (event.origin !== IALERT_ORIGIN) return;
  if (!event.data) return;

  if (event.data.type === 'IALERT_SESSION') {
    // Store if fresher than current
    if (isFresher(event.data.tokenValue)) {
      cachedSession = {
        token: event.data.token,
        refreshToken: event.data.refreshToken,
        tokenValue: event.data.tokenValue,
        ialertUserId: event.data.ialertUserId,
        ialertOwnerId: event.data.ialertOwnerId,
      };

      forwardSession(cachedSession);
    }
    return;
  }

  if (event.data.type === 'IALERT_ROTATED') {
    // Update rotation cache (always fresh, no epoch comparison needed)
    cachedRotation = {
      token: event.data.token,
      refreshToken: event.data.refreshToken,
    };

    // Forward to background
    try {
      chrome.runtime.sendMessage({
        type: 'IALERT_TOKEN_ROTATED',
        token: cachedRotation.token,
        refreshToken: cachedRotation.refreshToken,
      });
    } catch {
      // Background worker unavailable
    }
    return;
  }
});

/**
 * Link the captured session and tell the user, on this page, how it went.
 * The background answers with linkIalertSession()'s result (never a token).
 */
async function forwardSession(session) {
  showGnbBanner(ialertConnectingBanner());
  let result;
  try {
    result = await chrome.runtime.sendMessage({ type: 'IALERT_SESSION_CAPTURED', session });
  } catch (err) {
    result = { success: false, error: err?.message || 'GNB Edge is not responding' };
  }
  if (result?.success) showGnbBanner(ialertLinkedBanner(result));
  else showGnbBanner(ialertFailureBanner(result));
}

// Listen for requests from the extension background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension itself may ask.
  if (sender.id !== chrome.runtime.id) return false;
  if (message?.type === 'READ_IALERT_SESSION') {
    sendResponse({ success: true, session: cachedSession });
    return false; // answered synchronously
  }
  if (message?.type === 'GNB_BANNER' && message.banner) {
    showGnbBanner(message.banner);
    sendResponse({ success: true });
    return false;
  }
  return false;
});

// Tell the background this tab can be asked for a session. The popup's
// Connect button uses this (the extension has no permission to list iALERT
// tabs by URL). Tab ids only; no session data.
try {
  Promise.resolve(chrome.runtime.sendMessage({ type: 'IALERT_TAB_READY' })).catch(() => {});
} catch {
  // Background worker unavailable
}
