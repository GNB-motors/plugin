/**
 * Tests for networkSpy.js (MAIN-world content script).
 *
 * The script is an IIFE that monkeypatches XMLHttpRequest.prototype and
 * window.fetch on whatever `globalThis`/`window` it sees at evaluation
 * time. We build a synthetic sandbox with the bare globals it touches
 * (window, XMLHttpRequest, fetch, Request, URL, console) and evaluate
 * the source inside it with vm.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPY_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'networkSpy.js'),
  'utf8'
);

const ORIGIN = 'https://fleetedge.home.tatamotors';

function makeFakeXhr(responseStatus, responseText) {
  class FakeXHR {
    constructor() {
      this._listeners = {};
      this.status = 0;
      this.responseText = responseText;
    }
    open(method, url) {
      this._method = method;
      this._url = url;
    }
    setRequestHeader(/* header, value */) {}
    send(/* body */) {
      // Simulate async network completion.
      setTimeout(() => {
        this.status = responseStatus;
        (this._listeners.load || []).forEach((fn) => fn.call(this));
      }, 0);
    }
    addEventListener(ev, fn) {
      (this._listeners[ev] ||= []).push(fn);
    }
    removeEventListener(ev, fn) {
      this._listeners[ev] = (this._listeners[ev] || []).filter((f) => f !== fn);
    }
  }
  return FakeXHR;
}

function buildSandbox({ xhrStatus = 200, xhrResponseText = '', fetchOk = true, fetchResponseBody = null } = {}) {
  const postedMessages = [];
  const FakeXHR = makeFakeXhr(xhrStatus, xhrResponseText);

  const fakeFetch = vi.fn(async () =>
    // Minimal Response-like object.
    ({ ok: fetchOk, status: fetchOk ? 200 : 500, clone: () => ({ json: async () => fetchResponseBody }) })
  );

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    URL,
    Request,
    Headers,
    Response,
    JSON,
  };
  sandbox.window = {
    location: { origin: ORIGIN },
    postMessage: (data, targetOrigin) => {
      postedMessages.push({ data, targetOrigin });
    },
    fetch: fakeFetch,
    addEventListener: () => {},
  };
  sandbox.XMLHttpRequest = FakeXHR;
  sandbox.fetch = fakeFetch;
  // The script reads `window.fetch` and reassigns it.
  vm.createContext(sandbox);
  vm.runInContext(SPY_SRC, sandbox);
  return { sandbox, postedMessages, FakeXHR };
}

describe('networkSpy XHR', () => {
  let sandbox, postedMessages, FakeXHR;
  beforeEach(() => {
    ({ sandbox, postedMessages, FakeXHR } = buildSandbox({ xhrStatus: 200 }));
  });

  it('emits intercept ONLY after 2xx response, never before send completes', async () => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', `${ORIGIN}/api/vehicle-service/get-vin-for-dashboard`);
    xhr.setRequestHeader('Authorization', 'Bearer real-token');
    xhr.send();

    // Synchronously after send(), nothing should have been posted yet.
    expect(postedMessages).toHaveLength(0);

    // Wait for the simulated load event to fire.
    await new Promise((r) => setTimeout(r, 5));

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.token).toBe('real-token');
    expect(postedMessages[0].targetOrigin).toBe(ORIGIN);
  });

  it('does NOT emit when response status is non-2xx', async () => {
    const { sandbox: sb, postedMessages: msgs } = buildSandbox({
      xhrStatus: 401,
    });
    const xhr = new sb.XMLHttpRequest();
    xhr.open('GET', `${ORIGIN}/api/vehicle-service/get-vin-for-dashboard`);
    xhr.setRequestHeader('Authorization', 'Bearer attacker-token');
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(msgs).toHaveLength(0);
  });

  it('does NOT emit for non-allow-list URLs even on 2xx', async () => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', `${ORIGIN}/api/random-service/foo`);
    xhr.setRequestHeader('Authorization', 'Bearer real-token');
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages).toHaveLength(0);
  });

  it('locks postMessage targetOrigin to window.location.origin (not "*")', async () => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', `${ORIGIN}/api/user-service/get-user-document-master`);
    xhr.setRequestHeader('Authorization', 'Bearer real-token');
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages[0].targetOrigin).toBe(ORIGIN);
    expect(postedMessages[0].targetOrigin).not.toBe('*');
  });

  it('clears buffered token across XHR re-use (open resets)', async () => {
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('GET', `${ORIGIN}/api/vehicle-service/a`);
    xhr.setRequestHeader('Authorization', 'Bearer first-token');
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    const before = postedMessages.length;

    // Re-use without setting auth header — should NOT emit second time.
    xhr.open('GET', `${ORIGIN}/api/vehicle-service/b`);
    xhr.send();
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages.length).toBe(before);
  });
});

describe('networkSpy fetch', () => {
  it('emits after fetch resolves with response.ok and URL on allow-list', async () => {
    const { sandbox, postedMessages } = buildSandbox({ fetchOk: true });
    await sandbox.window.fetch(
      `${ORIGIN}/api/vehicle-service/x`,
      { headers: { Authorization: 'Bearer fetch-token' } }
    );
    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.token).toBe('fetch-token');
    expect(postedMessages[0].targetOrigin).toBe(ORIGIN);
  });

  it('does NOT emit when response.ok is false', async () => {
    const { sandbox, postedMessages } = buildSandbox({ fetchOk: false });
    await sandbox.window.fetch(
      `${ORIGIN}/api/vehicle-service/x`,
      { headers: { Authorization: 'Bearer attacker-token' } }
    );
    expect(postedMessages).toHaveLength(0);
  });

  it('does NOT emit for non-allow-list paths', async () => {
    const { sandbox, postedMessages } = buildSandbox({ fetchOk: true });
    await sandbox.window.fetch(
      `${ORIGIN}/api/something-else/y`,
      { headers: { Authorization: 'Bearer t' } }
    );
    expect(postedMessages).toHaveLength(0);
  });
});

describe('networkSpy refresh-token capture (XHR)', () => {
  const REFRESH_URL = `${ORIGIN}/api/user-general/get-token-by-refresh-token`;
  const REQUEST_BODY = JSON.stringify({
    fleet_id: 'FLEET-1',
    is_tipper: false,
    refresh_token: 'request-refresh-token',
    req_by: 'PORTALS',
  });

  it('emits FLEETEDGE_REFRESH_INTERCEPT from the response body on 2xx (Basic auth, no Bearer)', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      xhrStatus: 200,
      xhrResponseText: JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'response-refresh-token',
      }),
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', REFRESH_URL);
    xhr.setRequestHeader('Authorization', 'Basic c3RhdGljLWNyZWRz');
    xhr.send(REQUEST_BODY);

    expect(postedMessages).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 5));

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.type).toBe('FLEETEDGE_REFRESH_INTERCEPT');
    expect(postedMessages[0].data.refreshToken).toBe('response-refresh-token');
    expect(postedMessages[0].data.fleetId).toBe('FLEET-1');
    expect(postedMessages[0].targetOrigin).toBe(ORIGIN);
  });

  it('falls back to the request body refresh_token when the response has none', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      xhrStatus: 200,
      xhrResponseText: JSON.stringify({ access_token: 'new-access' }),
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', REFRESH_URL);
    xhr.send(REQUEST_BODY);
    await new Promise((r) => setTimeout(r, 5));

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.type).toBe('FLEETEDGE_REFRESH_INTERCEPT');
    expect(postedMessages[0].data.refreshToken).toBe('request-refresh-token');
  });

  it('does NOT emit when the refresh response is non-2xx', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      xhrStatus: 401,
      xhrResponseText: JSON.stringify({ refresh_token: 'response-refresh-token' }),
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', REFRESH_URL);
    xhr.send(REQUEST_BODY);
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages).toHaveLength(0);
  });

  it('does NOT emit for other /api/user-general/ paths', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      xhrStatus: 200,
      xhrResponseText: JSON.stringify({ refresh_token: 'response-refresh-token' }),
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', `${ORIGIN}/api/user-general/some-other-endpoint`);
    xhr.send(REQUEST_BODY);
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages).toHaveLength(0);
  });

  it('does NOT emit for a cross-origin refresh URL', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      xhrStatus: 200,
      xhrResponseText: JSON.stringify({ refresh_token: 'response-refresh-token' }),
    });
    const xhr = new sandbox.XMLHttpRequest();
    xhr.open('POST', 'https://evil.example/api/user-general/get-token-by-refresh-token');
    xhr.send(REQUEST_BODY);
    await new Promise((r) => setTimeout(r, 5));
    expect(postedMessages).toHaveLength(0);
  });
});

describe('networkSpy refresh-token capture (fetch)', () => {
  const REFRESH_URL = `${ORIGIN}/api/user-general/get-token-by-refresh-token`;
  const REQUEST_BODY = JSON.stringify({
    fleet_id: 'FLEET-2',
    is_tipper: false,
    refresh_token: 'request-refresh-token',
    req_by: 'PORTALS',
  });

  it('emits FLEETEDGE_REFRESH_INTERCEPT from the cloned response body on 2xx', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      fetchOk: true,
      fetchResponseBody: { access_token: 'new-access', refresh_token: 'response-refresh-token' },
    });
    await sandbox.window.fetch(REFRESH_URL, {
      method: 'POST',
      headers: { Authorization: 'Basic c3RhdGljLWNyZWRz' },
      body: REQUEST_BODY,
    });

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.type).toBe('FLEETEDGE_REFRESH_INTERCEPT');
    expect(postedMessages[0].data.refreshToken).toBe('response-refresh-token');
    expect(postedMessages[0].data.fleetId).toBe('FLEET-2');
    expect(postedMessages[0].targetOrigin).toBe(ORIGIN);
  });

  it('falls back to the request body refresh_token when the response has none', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      fetchOk: true,
      fetchResponseBody: { access_token: 'new-access' },
    });
    await sandbox.window.fetch(REFRESH_URL, {
      method: 'POST',
      headers: { Authorization: 'Basic c3RhdGljLWNyZWRz' },
      body: REQUEST_BODY,
    });

    expect(postedMessages).toHaveLength(1);
    expect(postedMessages[0].data.refreshToken).toBe('request-refresh-token');
  });

  it('does NOT emit when the refresh response is not ok', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      fetchOk: false,
      fetchResponseBody: { refresh_token: 'response-refresh-token' },
    });
    await sandbox.window.fetch(REFRESH_URL, {
      method: 'POST',
      headers: { Authorization: 'Basic c3RhdGljLWNyZWRz' },
      body: REQUEST_BODY,
    });
    expect(postedMessages).toHaveLength(0);
  });

  it('does NOT emit for a non-allow-listed refresh path', async () => {
    const { sandbox, postedMessages } = buildSandbox({
      fetchOk: true,
      fetchResponseBody: { refresh_token: 'response-refresh-token' },
    });
    await sandbox.window.fetch(`${ORIGIN}/evil/api/user-general/get-token-by-refresh-token`, {
      method: 'POST',
      headers: { Authorization: 'Basic c3RhdGljLWNyZWRz' },
      body: REQUEST_BODY,
    });
    expect(postedMessages).toHaveLength(0);
  });
});
