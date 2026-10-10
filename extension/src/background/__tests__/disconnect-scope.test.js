/**
 * Disconnect scope — prod BD 2026-10-09: the backend read the account to unlink
 * only from the URL path, the extension sent it in the body, so "disconnect one
 * account" revoked every link of the user and the truck data stopped. The
 * account now goes in the path; "disconnect all" says so explicitly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

function chromeMock() {
  const store = {};
  return {
    storage: {
      local: {
        get: vi.fn((keys) => {
          const out = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) out[k] = store[k];
          });
          return Promise.resolve(out);
        }),
        set: vi.fn((obj) => Object.assign(store, obj) && Promise.resolve()),
        remove: vi.fn(() => Promise.resolve()),
      },
    },
    tabs: { query: vi.fn(() => Promise.resolve([])), sendMessage: vi.fn(), reload: vi.fn() },
    permissions: { contains: vi.fn(() => Promise.resolve(true)) },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    notifications: { create: vi.fn() },
  };
}

describe('disconnect scope', () => {
  let backendFetch;
  let mod;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubGlobal('chrome', chromeMock());
    backendFetch = vi.fn(() => Promise.resolve({}));
    vi.doMock('../backendApi.js', () => ({ backendFetch }));
    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));
    mod = await import('../fleetedgeLink.js');
  });

  it('disconnecting one account names it in the path', async () => {
    await mod.disconnectFleetEdgeAccount('acc1');
    expect(backendFetch).toHaveBeenCalledWith('/fleetedge/unlink/acc1', expect.objectContaining({ method: 'POST' }));
  });

  it('disconnecting every account says so explicitly', async () => {
    await mod.disconnectFleetEdge();
    const [path, opts] = backendFetch.mock.calls[0];
    expect(path).toBe('/fleetedge/unlink');
    expect(JSON.parse(opts.body)).toEqual({ all: true });
  });
});
