/**
 * FleetEdge Token Reader (ISOLATED World)
 * ───────────────────────────────────────
 * Receives the live token intercepted by the MAIN world networkSpy.js
 * via window.postMessage.
 *
 * Also contains fallback logic to scrape localStorage if the user hasn't
 * triggered a network request yet.
 */

let interceptedToken = null;
let interceptedFleetId = null;

// Origin lock for inbound postMessage intercepts (audit H-1). Only messages
// from the FleetEdge page origin are accepted. The MAIN-world spy is
// declared to run on this exact origin, so its postMessage will have
// event.origin === FLEETEDGE_ORIGIN.
const FLEETEDGE_ORIGIN = 'https://fleetedge.home.tatamotors';

// Listen for messages from the MAIN world spy script
window.addEventListener('message', (event) => {
  // Same-window check: reject messages from frames / cross-window sources.
  if (event.source !== window) return;
  // Origin check: reject forged messages claiming to be from a different
  // origin (e.g. a malicious userscript / other-extension MAIN-world script).
  if (event.origin !== FLEETEDGE_ORIGIN) return;
  if (!event.data || event.data.type !== 'FLEETEDGE_INTERCEPT') return;

  if (event.data.token) interceptedToken = event.data.token;
  if (event.data.fleetId) interceptedFleetId = event.data.fleetId;

  console.log('[FleetEdge Fuel Monitor] Intercepted live auth token from MAIN world network spy!');
});

// Listen for requests from the extension background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'READ_FLEETEDGE_TOKEN') {
    try {
      const result = readFleetEdgeToken();
      sendResponse(result);
    } catch (err) {
      sendResponse({ success: false, error: err.message });
    }
  }
  return true; // Keep message channel open for async response if needed
});

function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const jsonStr = atob(base64);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function readFleetEdgeToken() {
  // If we intercepted a live token, parse it immediately and return it.
  if (interceptedToken) {
    const payload = decodeJwtPayload(interceptedToken);

    // Always fall back to payload fleet_id if the intercept didn't catch a body with fleet_id
    let bestFleetId = interceptedFleetId;
    if (payload && payload.fleet_id) {
      bestFleetId = payload.fleet_id;
    }

    if (!bestFleetId) {
      bestFleetId = 'UNKNOWN_FLEET';
    }

    return {
      success: true,
      token: interceptedToken,
      fleetId: bestFleetId,
      exp: payload ? payload.exp : null,
      foundIn: 'live_network_intercept',
    };
  }

  // Fallback to the old method ONLY if intervention fails
  return fallbackLocalStorageScan();
}

function fallbackLocalStorageScan() {
  // Early exit: if a live token was intercepted while we were waiting, use it immediately
  if (interceptedToken) {
    return readFleetEdgeToken();
  }

  function isJwt(str) {
    if (typeof str !== 'string') return false;
    const parts = str.split('.');
    return parts.length === 3 && parts[1].length > 20;
  }

  const allJwts = [];
  const allFleetIds = [];

  function safeJSONParse(str) {
    try {
      return JSON.parse(str);
    } catch {
      return null;
    }
  }

  function scanStorage(storage, prefix) {
    if (!storage) return;
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      const value = storage.getItem(key);
      if (!value) continue;

      if (isJwt(value)) {
        allJwts.push({ token: value, payload: decodeJwtPayload(value), key: `${prefix}:${key}` });
      }

      const obj = safeJSONParse(value);
      if (obj && typeof obj === 'object') {
        const accessToken = obj.access_token || obj.token || obj.accessToken || obj.id_token;
        if (accessToken && isJwt(accessToken)) {
          allJwts.push({
            token: accessToken,
            payload: decodeJwtPayload(accessToken),
            key: `${prefix}:${key}`,
          });
        }
        if (obj.fleet_id) allFleetIds.push(String(obj.fleet_id));
        else if (obj.fleetId) allFleetIds.push(String(obj.fleetId));
        else if (obj.tenant_id) allFleetIds.push(String(obj.tenant_id));
      }

      const kLow = key.toLowerCase();
      if (kLow.includes('fleetid') || kLow.includes('fleet_id') || kLow.includes('tenant')) {
        if (typeof value === 'string' && value.length > 2 && !value.startsWith('{')) {
          allFleetIds.push(value);
        }
      }
    }
  }

  try {
    scanStorage(localStorage, 'local');
  } catch {
    console.debug('[FleetEdge Token Reader] Local storage access failed');
  }
  try {
    scanStorage(sessionStorage, 'session');
  } catch {
    console.debug('[FleetEdge Token Reader] Session storage access failed');
  }

  let bestJwt = null;
  const now = Date.now() / 1000;
  for (const jwtInfo of allJwts) {
    if (jwtInfo.payload && jwtInfo.payload.fleet_id) {
      bestJwt = jwtInfo;
      break;
    }
    if (
      !bestJwt ||
      ((!bestJwt.payload?.exp || bestJwt.payload.exp < now) && jwtInfo.payload?.exp > now)
    ) {
      bestJwt = jwtInfo;
    }
  }

  if (!bestJwt) {
    return {
      success: false,
      error:
        'Network interceptor is waiting for FleetEdge to load data. Scroll around the map on FleetEdge, then try connecting again.',
    };
  }

  let finalFleetId = null;
  if (bestJwt && bestJwt.payload && bestJwt.payload.fleet_id) {
    finalFleetId = bestJwt.payload.fleet_id;
  } else if (allFleetIds.length > 0) {
    finalFleetId = allFleetIds[0];
  } else {
    finalFleetId = 'UNKNOWN_FLEET';
  }

  return {
    success: true,
    token: bestJwt.token,
    fleetId: finalFleetId,
    exp: bestJwt.payload ? bestJwt.payload.exp : null,
    foundIn: bestJwt.key,
  };
}
