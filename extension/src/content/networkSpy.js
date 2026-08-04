/**
 * FleetEdge Network Spy
 * ──────────────────────
 * Executes in the MAIN world context.
 * Overrides XHR and fetch to snatch the live Authorization token,
 * sending it via postMessage to our ISOLATED content script for
 * 100% CWS-compliant interception without string-based injection.
 *
 * Security hardening (audit H-1, H-2):
 *   - postMessage targetOrigin is locked to window.location.origin instead
 *     of '*' so other same-window contexts cannot read the bearer token.
 *   - Captured Authorization headers are buffered and only emitted AFTER the
 *     underlying request returns a 2xx status, so a malicious page script
 *     cannot forge an XHR with an attacker-chosen Authorization header and
 *     have us upload it to the backend without the request actually
 *     succeeding against FleetEdge.
 *   - The captured URL must match an allow-list of FleetEdge API path
 *     prefixes (vehicle-service / user-service) before emitting.
 */

(function () {
  if (window.__fe_spy_initialized) return;
  window.__fe_spy_initialized = true;

  const TARGET_ORIGIN = window.location.origin;
  // The FleetEdge SPA is served from fleetedge.home.tatamotors but calls its API
  // on cvp.api.tatamotors — cross-origin, same-site (the browser sends
  // sec-fetch-site: same-site). Locking the allow-list to window.location.origin
  // alone therefore rejects every real API call and the spy never fires at all,
  // so both origins are listed explicitly. Anything else is still rejected, so
  // audit H-2 holds: a page script cannot point an XHR at a host of its choosing
  // and have us upload the bearer token.
  const FLEETEDGE_API_ORIGIN = 'https://cvp.api.tatamotors';
  const ALLOWED_ORIGINS = [TARGET_ORIGIN, FLEETEDGE_API_ORIGIN];
  const ALLOWED_PATH_PREFIXES = [
    '/api/vehicle-service/',
    '/api/user-service/',
    '/api/user-general/',
  ];
  // The refresh endpoint uses a static Basic auth header, so the Bearer
  // trigger never fires for it — it needs its own response-body capture path.
  const REFRESH_TOKEN_PATH = '/api/user-general/get-token-by-refresh-token';

  function isAllowedUrl(rawUrl) {
    if (!rawUrl) return false;
    try {
      // Coerce URL/URL-like objects to string so xhr.open(method, new URL(...))
      // still gets allow-listed.
      const normalizedUrl = typeof rawUrl === 'string' ? rawUrl : String(rawUrl);
      const u = new URL(normalizedUrl, TARGET_ORIGIN);
      if (!ALLOWED_ORIGINS.includes(u.origin)) return false;
      return ALLOWED_PATH_PREFIXES.some((p) => u.pathname.startsWith(p));
    } catch {
      return false;
    }
  }

  function extractFleetIdFromBody(body) {
    try {
      if (body && typeof body === 'string') {
        const parsed = JSON.parse(body);
        if (parsed.fleet_id) return parsed.fleet_id;
        if (parsed.fleetId) return parsed.fleetId;
      }
    } catch {
      // ignore parse failures
    }
    return null;
  }

  function emitIntercept(token, fleetId) {
    try {
      window.postMessage(
        { type: 'FLEETEDGE_INTERCEPT', token, fleetId },
        TARGET_ORIGIN
      );
    } catch {
      // postMessage failures are silent (do not log raw tokens)
    }
  }

  function isRefreshTokenUrl(rawUrl) {
    try {
      const u = new URL(String(rawUrl), TARGET_ORIGIN);
      return u.pathname.endsWith(REFRESH_TOKEN_PATH);
    } catch {
      return false;
    }
  }

  function extractRefreshTokenFromBody(body) {
    try {
      if (body && typeof body === 'string') {
        const parsed = JSON.parse(body);
        if (parsed.refresh_token) return parsed.refresh_token;
      }
    } catch {
      // ignore parse failures
    }
    return null;
  }

  function emitRefreshIntercept(refreshToken, fleetId) {
    try {
      window.postMessage(
        { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken, fleetId },
        TARGET_ORIGIN
      );
    } catch {
      // postMessage failures are silent (do not log raw tokens)
    }
  }

  // SPY ON XHR
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    this._method = method;
    // Reset any previously buffered token on this instance (re-used XHR safety).
    this._interceptedToken = null;
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (
      typeof header === 'string' &&
      header.toLowerCase() === 'authorization' &&
      typeof value === 'string' &&
      value.startsWith('Bearer ')
    ) {
      this._interceptedToken = value.substring(7); // Remove 'Bearer '
    }
    return originalXhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    // Refresh-token capture: the refresh endpoint authenticates with a static
    // Basic header, so the Bearer path never fires. Capture the rotated
    // refresh_token from the 2xx response body, falling back to the request
    // body's refresh_token.
    if (isAllowedUrl(this._url) && isRefreshTokenUrl(this._url)) {
      const requestBodyFleetId = extractFleetIdFromBody(body);
      const requestBodyRefreshToken = extractRefreshTokenFromBody(body);

      const onLoadRefresh = () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            const refreshToken =
              extractRefreshTokenFromBody(this.responseText) || requestBodyRefreshToken;
            if (refreshToken) {
              emitRefreshIntercept(refreshToken, requestBodyFleetId);
            }
          }
        } catch {
          // ignore
        } finally {
          this.removeEventListener('load', onLoadRefresh);
        }
      };
      this.addEventListener('load', onLoadRefresh);
    }

    // Only buffer/emit if we have an Authorization header AND the URL is
    // on the FleetEdge API allow-list. Defer the actual postMessage until
    // onload confirms a 2xx response.
    if (this._interceptedToken && isAllowedUrl(this._url)) {
      const bufferedToken = this._interceptedToken;
      const bufferedFleetId = extractFleetIdFromBody(body);

      const onLoad = () => {
        try {
          if (this.status >= 200 && this.status < 300) {
            emitIntercept(bufferedToken, bufferedFleetId);
          }
        } catch {
          // ignore
        } finally {
          this.removeEventListener('load', onLoad);
        }
      };
      this.addEventListener('load', onLoad);
    }
    return originalXhrSend.apply(this, arguments);
  };

  // SPY ON FETCH
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    let token = null;
    let url = null;
    let bodyForFleetId = null;
    try {
      // Normalise to a Request to read headers uniformly.
      const req = new Request(args[0], args[1]);
      url = req.url;
      const auth = req.headers.get('Authorization');
      if (auth && auth.startsWith('Bearer ')) {
        token = auth.substring(7);
      }
      if (args[1] && typeof args[1].body === 'string') {
        bodyForFleetId = args[1].body;
      }
    } catch {
      // If we can't parse the request, fall through to original fetch.
    }

    const response = await originalFetch.apply(this, args);

    try {
      // Refresh-token capture (Basic-auth endpoint — no Bearer trigger).
      if (isAllowedUrl(url) && isRefreshTokenUrl(url) && response && response.ok) {
        let refreshToken = null;
        try {
          // Clone before reading so the page's own response body stays intact.
          const data = await response.clone().json();
          if (data && data.refresh_token) refreshToken = data.refresh_token;
        } catch {
          // Unreadable body — fall back to the request body's refresh_token.
        }
        if (!refreshToken) refreshToken = extractRefreshTokenFromBody(bodyForFleetId);
        if (refreshToken) {
          emitRefreshIntercept(refreshToken, extractFleetIdFromBody(bodyForFleetId));
        }
      } else if (token && isAllowedUrl(url) && response && response.ok) {
        emitIntercept(token, extractFleetIdFromBody(bodyForFleetId));
      }
    } catch {
      // Never let interception break the page's fetch chain.
    }
    return response;
  };

  // Silent init — no console output to avoid detection in MAIN world
})();
