/**
 * iALERT Link Tests
 * ═══════════════════════════════════════════════════════
 * Tests for ialertLink.js functionality
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ialertLink', () => {
  let store = {};
  let session = {};
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
      sendMessage: vi.fn(() => Promise.resolve(null)),
      update: vi.fn(() => Promise.resolve({})),
      get: vi.fn((id) => Promise.resolve({ id, windowId: 7 })),
    },
    windows: { update: vi.fn(() => Promise.resolve({})) },
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    store = { authToken: 'test-jwt-token' }; // Add auth token by default
    fetchMock = null;
    vi.stubGlobal('chrome', makeChrome());
    session = {};
    chrome.storage.session = {
      get: vi.fn((keys) =>
        Promise.resolve(
          Object.fromEntries(keys.filter((k) => k in session).map((k) => [k, session[k]]))
        )
      ),
      set: vi.fn((data) => {
        Object.assign(session, data);
        return Promise.resolve();
      }),
    };
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
        if (url.endsWith('/api/extension/ialert/link-token')) {
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
            Promise.resolve({
              status: 'error',
              statusCode: 400,
              code: 'IALERT_TOKEN_TOO_OLD',
              message: TOO_OLD,
            }),
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
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'success', data: rows }),
        })
      );
      const { mod } = await setupIalertLink();
      const result = await mod.refreshIalertStatus();
      expect(result.accounts).toEqual(rows);
      expect(store.ialertAccounts).toEqual(rows);
    });

    it('a rotation is forwarded with the stored tokenValue and user id', async () => {
      store.ialertMeta = {
        tokenValue: '179226993000200002',
        ialertUserId: '200002',
        ialertOwnerId: '200002',
      };
      let body = null;
      let url = null;
      fetchMock = vi.fn((u, opts) => {
        url = u;
        body = JSON.parse(opts.body);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'success', data: {} }),
        });
      });
      const { mod } = await setupIalertLink();
      await mod.forwardIalertRotation({ token: 'NEW-A', refreshToken: 'NEW-R' });
      expect(url).toBe('http://localhost:3000/api/extension/ialert/refresh-token-rotated');
      expect(body).toEqual({
        token: 'NEW-A',
        refreshToken: 'NEW-R',
        tokenValue: '179226993000200002',
        ialertUserId: '200002',
      });
    });
  });

  // backendFetch already prefixes API_PREFIX (/api/extension), so callers pass
  // the path BELOW it. A doubled /extension 404s on the live server, and the
  // popup reads that 404 as "Your GNB server doesn't support iALERT yet".
  describe('request URLs match the backend routes exactly', () => {
    const BASE = 'http://localhost:3000/api/extension';
    const ok = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'success', data: [] }) });
    const paths = () =>
      fetchMock.mock.calls.map(([u, opts]) => [opts?.method || 'GET', u.split('?')[0]]);

    it('link-token', async () => {
      fetchMock = vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { accountId: 'a1' } }) })
      );
      const { mod } = await setupIalertLink();
      await mod.linkIalertSession({
        token: 't',
        tokenValue: '179226993000200002',
        ialertUserId: '200002',
        ialertOwnerId: '410001',
      });
      expect(paths()).toEqual([['POST', `${BASE}/ialert/link-token`]]);
    });

    it('refresh-token-rotated', async () => {
      store.ialertMeta = { tokenValue: '179226993000200002', ialertUserId: '200002' };
      fetchMock = vi.fn(ok);
      const { mod } = await setupIalertLink();
      await mod.forwardIalertRotation({ token: 'A', refreshToken: 'R' });
      expect(paths()).toEqual([['POST', `${BASE}/ialert/refresh-token-rotated`]]);
    });

    it('status', async () => {
      fetchMock = vi.fn(ok);
      const { mod } = await setupIalertLink();
      await mod.refreshIalertStatus();
      expect(paths()).toEqual([['GET', `${BASE}/ialert/status`]]);
    });

    it('unlink one and unlink all', async () => {
      fetchMock = vi.fn(ok);
      const { mod } = await setupIalertLink();
      await mod.unlinkIalert('0123456789abcdef01234567');
      await mod.unlinkIalert(null);
      expect(paths()).toEqual([
        ['POST', `${BASE}/ialert/unlink/0123456789abcdef01234567`],
        ['POST', `${BASE}/ialert/unlink`],
      ]);
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

  describe('connectIalert (the popup button)', () => {
    const SESSION = {
      token: 'A',
      refreshToken: null,
      tokenValue: '179226993000200002',
      ialertUserId: '200002',
      ialertOwnerId: '410001',
    };
    const linkOk = (data = { accountId: 'acc-1', refreshStored: false }) =>
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'success', data }) })
      );
    const bannersTo = () =>
      chrome.tabs.sendMessage.mock.calls
        .filter(([, m]) => m.type === 'GNB_BANNER')
        .map(([id, m]) => [id, m.banner]);

    it('links the session an open, signed-in iALERT tab holds, and confirms on that tab', async () => {
      fetchMock = linkOk();
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      chrome.tabs.sendMessage.mockImplementation((id, m) =>
        Promise.resolve(
          m.type === 'READ_IALERT_SESSION' ? { success: true, session: SESSION } : { success: true }
        )
      );
      const result = await mod.connectIalert();
      expect(result).toMatchObject({
        success: true,
        state: 'LINKED',
        accountId: 'acc-1',
        refreshStored: false,
      });
      expect(bannersTo()).toEqual([[11, expect.objectContaining({ tone: 'ok' })]]);
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

    it('a too-old sign-in asks for a fresh iALERT sign-in on that tab', async () => {
      fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          headers: { get: () => null },
          json: () => Promise.resolve({ code: 'IALERT_TOKEN_TOO_OLD', message: 'too old' }),
        })
      );
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      chrome.tabs.sendMessage.mockImplementation((id, m) =>
        Promise.resolve(
          m.type === 'READ_IALERT_SESSION' ? { success: true, session: SESSION } : { success: true }
        )
      );
      const result = await mod.connectIalert();
      expect(result).toMatchObject({ success: false, state: 'SIGN_IN_AGAIN' });
      expect(bannersTo()[0][1]).toMatchObject({ tone: 'warn', title: 'Sign in to iALERT again' });
    });

    it('any other link failure is FAILED with an error banner', async () => {
      fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve({ message: 'boom' }),
        })
      );
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      chrome.tabs.sendMessage.mockImplementation((id, m) =>
        Promise.resolve(
          m.type === 'READ_IALERT_SESSION' ? { success: true, session: SESSION } : { success: true }
        )
      );
      const result = await mod.connectIalert();
      expect(result).toMatchObject({ success: false, state: 'FAILED' });
      expect(bannersTo()[0][1].tone).toBe('err');
    });

    it('an open tab without a sign-in is focused and told what to do', async () => {
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      chrome.tabs.sendMessage.mockImplementation(() =>
        Promise.resolve({ success: true, session: null })
      );
      const result = await mod.connectIalert();
      expect(result).toEqual({ success: true, state: 'WAITING', tab: 'focused' });
      expect(chrome.tabs.update).toHaveBeenCalledWith(11, { active: true });
      expect(chrome.windows.update).toHaveBeenCalledWith(7, { focused: true });
      expect(bannersTo()[0][1]).toMatchObject({ tone: 'progress', title: 'Sign in to iALERT' });
      expect(chrome.tabs.create).not.toHaveBeenCalled();
    });

    it('a tab that no longer answers is forgotten, and iALERT opens instead', async () => {
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      chrome.tabs.sendMessage.mockImplementation(() =>
        Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'))
      );
      const result = await mod.connectIalert();
      expect(result).toEqual({ success: true, state: 'WAITING', tab: 'opened' });
      expect(chrome.tabs.create).toHaveBeenCalledWith({ url: 'https://ialert.ashokleyland.com/' });
      expect(session.ialertTabIds).toEqual([]);
    });

    it('no known iALERT tab: opens iALERT', async () => {
      const { mod } = await setupIalertLink();
      const result = await mod.connectIalert();
      expect(result).toEqual({ success: true, state: 'WAITING', tab: 'opened' });
    });

    it('asks the newest tab first and keeps tab ids only', async () => {
      fetchMock = linkOk();
      const { mod } = await setupIalertLink();
      await mod.trackIalertTab(11);
      await mod.trackIalertTab(22);
      await mod.trackIalertTab(11); // reload of tab 11 → newest again
      expect(session.ialertTabIds).toEqual([22, 11]);
      chrome.tabs.sendMessage.mockImplementation((id, m) =>
        Promise.resolve(
          m.type === 'READ_IALERT_SESSION' ? { success: true, session: SESSION } : { success: true }
        )
      );
      await mod.connectIalert();
      expect(chrome.tabs.sendMessage.mock.calls[0][0]).toBe(11);
      await mod.untrackIalertTab(22);
      expect(session.ialertTabIds).toEqual([11]);
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
