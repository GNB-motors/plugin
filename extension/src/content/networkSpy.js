/**
 * FleetEdge Network Spy
 * ──────────────────────
 * Executes in the MAIN world context.
 * Overrides XHR and fetch to snatch the live Authorization token,
 * sending it via postMessage to our ISOLATED content script for
 * 100% CWS-compliant interception without string-based injection.
 */

(function () {
  if (window.__fe_spy_initialized) return;
  window.__fe_spy_initialized = true;

  // SPY ON XHR
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    this._method = method;
    return originalXhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    if (
      header.toLowerCase() === 'authorization' &&
      typeof value === 'string' &&
      value.startsWith('Bearer ')
    ) {
      this._interceptedToken = value.substring(7); // Remove 'Bearer '
    }
    return originalXhrSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._interceptedToken) {
      let fleetId = null;
      try {
        if (body && typeof body === 'string') {
          const parsed = JSON.parse(body);
          if (parsed.fleet_id) fleetId = parsed.fleet_id;
          else if (parsed.fleetId) fleetId = parsed.fleetId;
        }
      } catch (e) {
        console.debug('[FleetEdge Interceptor] Parsing error:', e);
      }
      window.postMessage(
        { type: 'FLEETEDGE_INTERCEPT', token: this._interceptedToken, fleetId },
        window.location.origin
      );
    }
    return originalXhrSend.apply(this, arguments);
  };

  // SPY ON FETCH
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      // fetch can take a string or a Request object
      const req = typeof args[0] === 'string' ? new Request(args[0], args[1]) : args[0].clone();
      const auth = req.headers.get('Authorization');

      if (auth && auth.startsWith('Bearer ')) {
        const token = auth.substring(7);
        let fleetId = null;

        try {
          if (args[1] && typeof args[1].body === 'string') {
            const body = JSON.parse(args[1].body);
            if (body.fleet_id) fleetId = body.fleet_id;
            else if (body.fleetId) fleetId = body.fleetId;
          }
        } catch (e) {
          console.debug('[FleetEdge Interceptor] Parsing error:', e);
        }

        window.postMessage({ type: 'FLEETEDGE_INTERCEPT', token, fleetId }, window.location.origin);
      }
    } catch (e) {
      console.debug('[FleetEdge Interceptor] Fetch error:', e);
    }

    return originalFetch.apply(this, args);
  };

  // Silent init — no console output to avoid detection in MAIN world
})();
