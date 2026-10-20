/**
 * iALERT Link Tests
 * ═══════════════════════════════════════════════════════
 * Tests for ialertLink.js functionality
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ialertLink', () => {
  let store = {};
  let fetchMock;

  // Shared chrome mock
  const makeChrome = () => ({
    storage: {
      local: {
        get: vi.fn((keys) => {
          const result = {};
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => {
            if (k in store) result[k] = store[k];
          });
          return Promise.resolve(result);
        }),
        set: vi.fn((data) => {
          Object.assign(store, data);
          return Promise.resolve();
        }),
        remove: vi.fn((keys) => {
          (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete store[k]);
          return Promise.resolve();
        }),
      },
    },
    tabs: {
      create: vi.fn(() => Promise.resolve({ id: 1 })),
    },
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    store = { authToken: 'test-jwt-token' }; // Add auth token by default
    fetchMock = null;
    vi.stubGlobal('chrome', makeChrome());
  });

  afterEach(() => {
    vi.resetModules();
  });

  async function setupIalertLink() {
    vi.doMock('../logger.js', () => ({
      createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    }));

    vi.doMock('../config.js', () => ({
      config: { BACKEND_BASE_URL: 'http://localhost:3000', API_PREFIX: '/api/extension' },
    }));

    vi.doMock('../telemetry.js', () => ({
      createLayerLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        perfStart: vi.fn(),
        perfEnd: vi.fn(),
      }),
      LAYERS: {
        UI: 'UI',
        MESSAGE: 'MESSAGE',
        BACKEND: 'BACKEND',
        FLEETEDGE: 'FLEETEDGE',
        IALERT: 'IALERT',
        STORAGE: 'STORAGE',
        TOKEN: 'TOKEN',
        TASK: 'TASK',
      },
    }));

    if (fetchMock) vi.stubGlobal('fetch', fetchMock);

    const mod = await import('../ialertLink.js');
    return { mod };
  }

  describe('linkIalertSession', () => {
    it('POST body contains exactly 5 keys: token, refreshToken, tokenValue, ialertUserId, ialertOwnerId', async () => {
      let capturedBody = null;
      fetchMock = vi.fn((url, opts) => {
        if (url.includes('/extension/ialert/link-token')) {
          capturedBody = JSON.parse(opts.body);
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { accountId: 'acc-123', refreshRejected: null } }),
        });
      });

      const { mod } = await setupIalertLink();

      await mod.linkIalertSession({
        token: 'access-token',
        refreshToken: 'refresh-token',
        tokenValue: '1234567890abc',
        ialertUserId: '123',
        ialertOwnerId: '456',
      });

      expect(capturedBody).toEqual({
        token: 'access-token',
        refreshToken: 'refresh-token',
        tokenValue: '1234567890abc',
        ialertUserId: '123',
        ialertOwnerId: '456',
      });
    });

    it('TOO_OLD error message surfaced verbatim', async () => {
      fetchMock = vi.fn(() => {
        const err = new Error('Token too old');
        err.code = 'IALERT_TOKEN_TOO_OLD';
        throw err;
      });

      const { mod } = await setupIalertLink();

      const result = await mod.linkIalertSession({
        token: 'old-token',
        refreshToken: 'old-refresh',
        tokenValue: '1234567890old',
        ialertUserId: '123',
        ialertOwnerId: '456',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Token too old');
    });

    it('storage never contains token or refreshToken', async () => {
      fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { accountId: 'acc-123', refreshRejected: null } }),
        })
      );

      const { mod } = await setupIalertLink();

      await mod.linkIalertSession({
        token: 'secret-token',
        refreshToken: 'secret-refresh',
        tokenValue: '1234567890abc',
        ialertUserId: '123',
        ialertOwnerId: '456',
      });

      // Scan all stored values
      const allValues = Object.values(store).flatMap((v) =>
        typeof v === 'object' && v !== null ? Object.values(v) : [v]
      );

      expect(allValues).not.toContain('secret-token');
      expect(allValues).not.toContain('secret-refresh');
    });
  });

  describe('backend contract', () => {
    const TOO_OLD =
      'This iALERT session is too old to connect. Sign in to iALERT again, then connect within 10 minutes.';

    it('a real 400 IALERT_TOKEN_TOO_OLD body surfaces its message verbatim', async () => {
      fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          headers: { get: () => null },
          json: () =>
            Promise.resolve({ status: 'error', statusCode: 400, code: 'IALERT_TOKEN_TOO_OLD', message: TOO_OLD }),
        })
      );
      const { mod } = await setupIalertLink();
      const result = await mod.linkIalertSession({
        token: 't',
        refreshToken: null,
        tokenValue: '179226993000200002',
        ialertUserId: '1',
        ialertOwnerId: '1',
      });
      expect(result).toMatchObject({ success: false, error: TOO_OLD });
    });

    it('status rows arrive as the data array and are stored without tokens', async () => {
      const rows = [{ accountId: 'a1', externalAccountId: '410001', status: 'ACTIVE' }];
      fetchMock = vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'success', data: rows }) })
      );
      const { mod } = await setupIalertLink();
      const result = await mod.refreshIalertStatus();
      expect(result.accounts).toEqual(rows);
      expect(store.ialertAccounts).toEqual(rows);
    });

    it('a rotation is forwarded with the stored tokenValue and user id', async () => {
      store.ialertMeta = { tokenValue: '179226993000200002', ialertUserId: '200002', ialertOwnerId: '200002' };
      let body = null;
      let url = null;
      fetchMock = vi.fn((u, opts) => {
        url = u;
        body = JSON.parse(opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'success', data: {} }) });
      });
      const { mod } = await setupIalertLink();
      await mod.forwardIalertRotation({ token: 'NEW-A', refreshToken: 'NEW-R' });
      expect(url).toContain('/extension/ialert/refresh-token-rotated');
      expect(body).toEqual({
        token: 'NEW-A',
        refreshToken: 'NEW-R',
        tokenValue: '179226993000200002',
        ialertUserId: '200002',
      });
    });
  });

  describe('forwardIalertRotation', () => {
    it('no stored tokenValue → no fetch', async () => {
      fetchMock = vi.fn();

      const { mod } = await setupIalertLink();

      const result = await mod.forwardIalertRotation({
        token: 'new-token',
        refreshToken: 'new-refresh',
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
    });
  });

  describe('openIalertForSignIn', () => {
    it('opens iALERT in a new tab (no permission prompt; scripts are manifest-declared)', async () => {
      const { mod } = await setupIalertLink();
      const result = await mod.openIalertForSignIn();
      expect(result.success).toBe(true);
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://ialert.ashokleyland.com/' });
    });
  });
});
