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
let interceptedRefreshToken = null;

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
  if (!event.data) return;

  if (event.data.type === 'FLEETEDGE_REFRESH_INTERCEPT') {
    // The MAIN-world spy captured a rotated refresh token from the
    // Basic-auth get-token-by-refresh-token endpoint.
    if (event.data.refreshToken) interceptedRefreshToken = event.data.refreshToken;
    if (event.data.fleetId) interceptedFleetId = event.data.fleetId;

    // Refresh tokens are single-use: when the SPA rotates, the backend's stored
    // copy dies on the spot (the 2026-08-07 fleet-wide outage). Forward every
    // rotation to the background worker so the backend stays in sync instead of
    // discovering the death at the next 48h expiry.
    try {
      chrome.runtime.sendMessage({
        type: 'FLEETEDGE_REFRESH_ROTATED',
        refreshToken: event.data.refreshToken || null,
        fleetId: event.data.fleetId || null,
      });
    } catch {
      // background worker unavailable — the next link still carries the token
    }

    console.log('[FleetEdge Fuel Monitor] Intercepted refresh token from MAIN world network spy!');
    return;
  }

  if (event.data.type !== 'FLEETEDGE_INTERCEPT') return;

  if (event.data.token) interceptedToken = event.data.token;
  if (event.data.fleetId) interceptedFleetId = event.data.fleetId;

  console.log('[FleetEdge Fuel Monitor] Intercepted live auth token from MAIN world network spy!');
});

// Listen for requests from the extension background script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'READ_FLEETEDGE_TOKEN') {
    readFleetEdgeToken()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ success: false, error: err.message }));
  }
  return true; // Keep message channel open for the async response
});

// ─── SPA localStorage decryption ────────────────────────────────────────────
// The FleetEdge SPA encrypts localStorage `token` / `refresh_token` with
// AES-192-CBC; both constants are in its public JS bundle (environment.DKEY /
// environment.DIV, see FLEETEDGE_API_DISCOVERY.md). Decrypting here is what
// makes every link carry the CURRENT refresh token — the network spy only sees
// a refresh token when the SPA happens to call the refresh endpoint while we
// watch, which a fresh login never does. A link without a fresh refresh token
// leaves the backend holding a stale single-use one (the 2026-08-07 outage).
const SPA_LS_DKEY = 'cGx1dG9pc25vdGFjb21ldA==';
const SPA_LS_DIV = 'ttlshiwwuruawshl';

async function decryptSpaStorageValue(ciphertextB64) {
  try {
    if (!ciphertextB64 || typeof ciphertextB64 !== 'string') return null;
    const keyBytes = new TextEncoder().encode(SPA_LS_DKEY);
    const iv = new TextEncoder().encode(SPA_LS_DIV);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, [
      'decrypt',
    ]);
    const data = Uint8Array.from(atob(ciphertextB64), (c) => c.charCodeAt(0));
    const plain = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

/** The SPA's current tokens from localStorage, decrypted. Nulls when absent/undecryptable. */
async function readSpaStorageTokens() {
  const out = { token: null, refreshToken: null };
  try {
    out.token = await decryptSpaStorageValue(localStorage.getItem('token'));
    out.refreshToken = await decryptSpaStorageValue(localStorage.getItem('refresh_token'));
  } catch {
    // localStorage inaccessible — leave nulls
  }
  return out;
}

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

function newerByIat(a, b) {
  if (!a) return b;
  if (!b) return a;
  const ia = decodeJwtPayload(a)?.iat;
  const ib = decodeJwtPayload(b)?.iat;
  if (!Number.isFinite(ia) || !Number.isFinite(ib)) return b; // prefer localStorage when unsure
  return ia >= ib ? a : b;
}

async function readFleetEdgeToken() {
  // The SPA's localStorage always holds the current tokens, encrypted — this is
  // the only path that yields a FRESH refresh token on every read, including
  // right after a fresh login (no refresh call for the spy to intercept).
  const spa = await readSpaStorageTokens();

  // The MAIN-world spy may have captured a newer token during an in-flight
  // network request. Compare by iat; fall back to the SPA value when unsure or
  // when either token is not a decodable JWT. Without this comparison the spy's
  // module-level `let`s can win with a stale value from an older session.
  const bestAccessToken = newerByIat(interceptedToken, spa.token);
  const bestRefreshToken = newerByIat(interceptedRefreshToken, spa.refreshToken);
  const bestFleetId = interceptedFleetId || null;

  if (bestAccessToken) {
    const payload = decodeJwtPayload(bestAccessToken);
    let resolvedFleetId = bestFleetId;
    if (payload && payload.fleet_id) {
      resolvedFleetId = payload.fleet_id;
    }
    if (!resolvedFleetId) {
      resolvedFleetId = 'UNKNOWN_FLEET';
    }

    return {
      success: true,
      token: bestAccessToken,
      fleetId: resolvedFleetId,
      refreshToken: bestRefreshToken,
      exp: payload ? payload.exp : null,
      foundIn: bestAccessToken === interceptedToken ? 'live_network_intercept' : 'spa_localstorage_decrypted',
    };
  }

  // No live intercept and no decryptable SPA access token: fall back to the old
  // broad localStorage / sessionStorage scan.
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
