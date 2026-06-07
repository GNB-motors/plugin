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
const READER_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'fleetedgeTokenReader.js'),
  'utf8'
);

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
    let result;
    runtimeMessageHandler(
      { type: 'READ_FLEETEDGE_TOKEN' },
      {},
      (r) => {
        result = r;
      }
    );
    return result;
  }

  return { sandbox, dispatch, readToken };
}

describe('fleetedgeTokenReader message listener (audit H-1)', () => {
  let r;
  beforeEach(() => {
    r = buildReader();
  });

  it('accepts a same-window message from the FleetEdge origin', () => {
    const token = makeJwt({ exp: Math.floor(Date.now() / 1000) + 3600, fleet_id: 'FLEET-OK' });
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token, fleetId: 'FLEET-OK' },
    });
    const result = r.readToken();
    expect(result.success).toBe(true);
    expect(result.token).toBe(token);
    expect(result.fleetId).toBe('FLEET-OK');
  });

  it('REJECTS a forged-origin message (event.origin !== FleetEdge origin)', () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: 'https://evil.example',
      data: { type: 'FLEETEDGE_INTERCEPT', token: 'attacker-token', fleetId: 'EVIL' },
    });
    const result = r.readToken();
    // No live intercept stored → falls back to storage scan → "waiting" error.
    expect(result.success).toBe(false);
  });

  it('REJECTS a cross-window message (event.source !== window)', () => {
    r.dispatch({
      source: { not: 'window' },
      origin: ORIGIN,
      data: { type: 'FLEETEDGE_INTERCEPT', token: 'attacker-token', fleetId: 'EVIL' },
    });
    const result = r.readToken();
    expect(result.success).toBe(false);
  });

  it('ignores messages with wrong type even from correct origin', () => {
    r.dispatch({
      source: r.sandbox.window,
      origin: ORIGIN,
      data: { type: 'SOMETHING_ELSE', token: 't' },
    });
    const result = r.readToken();
    expect(result.success).toBe(false);
  });
});
