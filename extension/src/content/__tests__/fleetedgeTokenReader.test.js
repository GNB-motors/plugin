/**
 * Tests for fleetedgeTokenReader.js (ISOLATED-world content script).
 *
 * Focus: audit H-1 origin lock on the inbound `message` listener.
 * A forged-origin `FLEETEDGE_INTERCEPT` message must be rejected so an
 * attacker cannot poison `interceptedToken` / `interceptedFleetId`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The reader is executed as raw source inside a vm sandbox, which has no module
// loader — so its one ESM import (the AES-192-CBC fallback) is resolved here by
// inlining that module's source instead. aes192cbc.js has its own dedicated
// test; this only keeps the sandbox self-contained.
const AES_SRC = fs
  .readFileSync(path.join(__dirname, '..', 'aes192cbc.js'), 'utf8')
  .replace(/^export /gm, '');
const READER_SRC =
  AES_SRC +
  '\n' +
  fs
    .readFileSync(path.join(__dirname, '..', 'fleetedgeTokenReader.js'), 'utf8')
    .replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/aes192cbc\.js';\s*$/gm, '');

const ORIGIN = 'https://fleetedge.home.tatamotors';

function b64url(str) {
  return btoa(str)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function makeJwt(payload) {
  const enc = (o) => b64url(JSON.stringify(o));
  return `${enc({ alg: 'HS256' })}.${enc(payload)}.sigsigsigsigsigsigsigsigsig`;
}

function buildReader() {
  const listeners = { message: [] };
  let runtimeMessageHandler = null;

  const fakeWindow = {
    addEventListener: (ev, fn) => {
      (listeners[ev] ||= []).push(fn);
    },
  };

  const sandbox = {
    console: { log: vi.fn(), debug: vi.fn() },
    JSON,
    atob: (s) => atob(s),
    btoa: (s) => btoa(s),
    TextEncoder,
    TextDecoder,
    Uint8Array,
    crypto,
    localStorage: { length: 0, key: () => null, getItem: () => null },
    sessionStorage: { length: 0, key: () => null, getItem: () => null },
  };
  sandbox.window = fakeWindow;
  // `window.addEventListener` is referenced via bare `window` in the source,
  // but the script also uses bare `window.addEventListener` at top level via
  // `window.addEventListener(...)`. The IIFE uses `window` as a global.
  sandbox.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => {
          runtimeMessageHandler = fn;
        },
      },
      sendMessage: vi.fn(),
    },
  };
  // Bare globals used inside the source:
  sandbox.addEventListener = fakeWindow.addEventListener;

  vm.createContext(sandbox);
  vm.runInContext(READER_SRC, sandbox);

  function dispatch(event) {
    listeners.message.forEach((fn) => fn(event));
  }

  function readToken() {
    return new Promise((resolve, reject) => {
      const ret = runtimeMessageHandler(
        { type: 'READ_FLEETEDGE_TOKEN' },
        {},
        (r) => resolve(r)
      );
      // Handler returns true and responds asynchronously via sendResponse.
      if (ret !== true) reject(new Error('handler did not keep the channel open'));
    });
  }

  return { sandbox, dispatch, readToken };
}

describe('fleetedgeTokenReader message listener (audit H-1)', () => {
  let r;
  beforeEach(() => {
    r = buildReader();
  });

  it('accepts a same-window message from the FleetEdge origin', async () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-OK' });
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token, fleetId: 'FLEET-OK' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(token);
    expect(result.fleetId).toBe('FLEET-OK');
  });

  it('REJECTS a forged-origin message (event.origin !== FleetEdge origin)', async () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: 'https://evil.example',
      data: { type: 'FLEETEDGE_INTERCEPT', token: 'attacker-token', fleetId: 'EVIL' },
    });
    const result = await r.readToken();
    // No live intercept stored → falls back to storage scan → "waiting" error.
    expect(result.success).toBe(false);
  });

  it('REJECTS a cross-window message (event.source !== window)', async () => {
    r.dispatch({
      source: { not: 'window' },
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token: 'attacker-token', fleetId: 'EVIL' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(false);
  });

  it('ignores messages with wrong type even from correct origin', async () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'SOMETHING_ELSE', token: 't' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(false);
  });
});

describe('fleetedgeTokenReader refresh-token intercept', () => {
  let r;
  beforeEach(() => {
    r = buildReader();
    // Seed a valid live token so READ_FLEETEDGE_TOKEN returns the
    // live_network_intercept success shape (which carries refreshToken).
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-OK' });
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token, fleetId: 'FLEET-OK' },
    });
  });

  it('stores a same-window FLEETEDGE_REFRESH_INTERCEPT from the FleetEdge origin and returns it', async () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken: 'rt-123', fleetId: 'FLEET-OK' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBe('rt-123');
    expect(result.fleetId).toBe('FLEET-OK');
  });

  it('returns refreshToken: null when no refresh intercept was received', async () => {
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBeNull();
  });

  it('REJECTS a forged-origin FLEETEDGE_REFRESH_INTERCEPT', async () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: 'https://evil.example',
      data: { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken: 'attacker-rt', fleetId: 'EVIL' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBeNull();
    expect(result.fleetId).toBe('FLEET-OK');
  });

  it('REJECTS a cross-window FLEETEDGE_REFRESH_INTERCEPT (event.source !== window)', async () => {
    r.dispatch({
      source: { not: 'window' },
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken: 'attacker-rt', fleetId: 'EVIL' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBeNull();
    expect(result.fleetId).toBe('FLEET-OK');
  });

  it('forwards every rotation to the background worker (single-use token sync)', async () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken: 'rt-rotated', fleetId: 'FLEET-OK' },
    });
    expect(r.sandbox.chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'FLEETEDGE_REFRESH_ROTATED',
      refreshToken: 'rt-rotated',
      fleetId: 'FLEET-OK',
    });
  });
});

describe('fleetedgeTokenReader SPA localStorage decryption', () => {
  // The SPA encrypts localStorage token/refresh_token with AES-192-CBC using
  // these public-bundle constants (FLEETEDGE_API_DISCOVERY.md).
  const SPA_DKEY = 'cGx1dG9pc25vdGFjb21ldA==';
  const SPA_DIV = 'ttlshiwwuruawshl';

  async function spaEncrypt(plaintext) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(SPA_DKEY),
      { name: 'AES-CBC' },
      false,
      ['encrypt']
    );
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-CBC', iv: new TextEncoder().encode(SPA_DIV) },
      key,
      new TextEncoder().encode(plaintext)
    );
    return btoa(String.fromCharCode(...new Uint8Array(ct)));
  }

  it('decrypts what it encrypts — plumbing only, not constant verification', async () => {
    // This test pins the decrypt plumbing against regression. It does NOT
    // prove the AES constants match the live FleetEdge SPA bundle; that
    // confirmation must be run once against a real browser (Part B step 3).
    const access = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-LS' });
    const refresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const r = buildReader();
    const store = {
      token: await spaEncrypt(access),
      refresh_token: await spaEncrypt(refresh),
    };
    r.sandbox.localStorage = {
      length: 2,
      key: (i) => Object.keys(store)[i],
      getItem: (k) => store[k] ?? null,
    };

    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(access);
    expect(result.refreshToken).toBe(refresh);
    expect(result.fleetId).toBe('FLEET-LS');
    expect(result.foundIn).toBe('spa_localstorage_decrypted');
  });

  it('still decrypts when the engine refuses AES-192, as Chromium does', async () => {
    // The bug this guards: Chromium (Chrome AND Edge) implements AES-128 and
    // AES-256 but not AES-192, so crypto.subtle.importKey throws on the SPA's
    // 24-byte key. Node — and therefore every previous test and the original
    // Playwright verification — DOES support AES-192, so the decrypt looked
    // healthy everywhere except the one place it ran. Every link then fell back
    // to the network spy, which only sees a refresh token when the SPA happens
    // to call the refresh endpoint: fine on a long-lived tab, silently empty on
    // a fresh login. Simulate the refusal and require the JS fallback to cover.
    const access = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-CHROMIUM' });
    const refresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const store = {
      token: await spaEncrypt(access),
      refresh_token: await spaEncrypt(refresh),
    };
    const r = buildReader();
    r.sandbox.localStorage = {
      length: 2,
      key: (i) => Object.keys(store)[i],
      getItem: (k) => store[k] ?? null,
    };
    r.sandbox.crypto = {
      subtle: {
        importKey: () => {
          const err = new Error('192-bit AES keys are not supported');
          err.name = 'NotSupportedError';
          return Promise.reject(err);
        },
      },
    };

    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(access);
    expect(result.refreshToken).toBe(refresh);
    expect(result.foundIn).toBe('spa_localstorage_decrypted');
  });

  it('a fresh login (no spy traffic) still yields a fresh refresh token', async () => {
    // THE 2026-08-07 regression: a re-link captured only the access token and
    // the backend kept the dead refresh token. localStorage decrypt closes that.
    const access = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-OK' });
    const refresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const r = buildReader();
    r.sandbox.localStorage = {
      length: 2,
      key: (i) => ['token', 'refresh_token'][i],
      getItem: () => null,
    };
    // Decrypt path reads via getItem — rebind with encrypted values.
    const store = { token: await spaEncrypt(access), refresh_token: await spaEncrypt(refresh) };
    r.sandbox.localStorage.getItem = (k) => store[k] ?? null;

    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBe(refresh);
  });

  it('a live intercept wins for the access token; localStorage still supplies the refresh token', async () => {
    const liveAccess = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-OK' });
    const refresh = makeJwt({ exp: Math.floor(Date.now() / 1000) + 86400 });
    const r = buildReader();
    const store = { refresh_token: await spaEncrypt(refresh) };
    r.sandbox.localStorage = {
      length: 1,
      key: () => 'refresh_token',
      getItem: (k) => store[k] ?? null,
    };
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token: liveAccess, fleetId: 'FLEET-OK' },
    });

    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(liveAccess);
    expect(result.refreshToken).toBe(refresh);
    expect(result.foundIn).toBe('live_network_intercept');
  });

  it('falls back to the legacy scan when SPA storage is undecryptable', async () => {
    const r = buildReader();
    r.sandbox.localStorage = {
      length: 1,
      key: () => 'token',
      getItem: () => 'not-valid-base64-ciphertext!!!',
    };
    const result = await r.readToken();
    // No intercept, no decryptable SPA token → legacy scan finds nothing.
    expect(result.success).toBe(false);
  });

  it('prefers the SPA access token when the intercepted token is older by iat', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldAccess = makeJwt({ iat: now - 1000, exp: now + 3600, fleet_id: 'FLEET-OLD' });
    const newAccess = makeJwt({ iat: now, exp: now + 3600, fleet_id: 'FLEET-NEW' });
    const refresh = makeJwt({ exp: now + 86400 });
    const r = buildReader();
    const store = { token: await spaEncrypt(newAccess), refresh_token: await spaEncrypt(refresh) };
    r.sandbox.localStorage = {
      length: 2,
      key: (i) => Object.keys(store)[i],
      getItem: (k) => store[k] ?? null,
    };
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token: oldAccess, fleetId: 'FLEET-OLD' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(newAccess);
    expect(result.fleetId).toBe('FLEET-NEW');
    expect(result.refreshToken).toBe(refresh);
    expect(result.foundIn).toBe('spa_localstorage_decrypted');
  });

  it('prefers the newer refresh token by iat, regardless of source', async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldRefresh = makeJwt({ iat: now - 1000, exp: now + 86400 });
    const newRefresh = makeJwt({ iat: now, exp: now + 86400 });
    const access = makeJwt({ exp: now + 3600, fleet_id: 'FLEET-OK' });
    const r = buildReader();
    const store = { token: await spaEncrypt(access), refresh_token: await spaEncrypt(newRefresh) };
    r.sandbox.localStorage = {
      length: 2,
      key: (i) => Object.keys(store)[i],
      getItem: (k) => store[k] ?? null,
    };
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_REFRESH_INTERCEPT', refreshToken: oldRefresh, fleetId: 'FLEET-OK' },
    });
    const result = await r.readToken();
    expect(result.success).toBe(true);
    expect(result.refreshToken).toBe(newRefresh);
  });
});
