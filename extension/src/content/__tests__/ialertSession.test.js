/**
 * iALERT session capture — tests the REAL content-script modules
 * (ialertSessionSpy.js in the MAIN world, ialertSessionReader.js in the
 * ISOLATED world) by importing them against stubbed globals.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGIN = 'https://ialert.ashokleyland.com';
const enc = (obj) => new TextEncoder().encode(typeof obj === 'string' ? obj : JSON.stringify(obj));

const LOGIN = {
  data: {
    user_id: 200002,
    owner_id: 200002,
    token_value: '179226993000200002',
    token: 'ACCESS-T',
    refresh_token: 'REFRESH-T',
  },
};

describe('ialertSessionSpy (real module)', () => {
  let posted;
  let realDecrypt;

  async function loadSpy(decryptImpl) {
    posted = [];
    realDecrypt = vi.fn(decryptImpl);
    vi.stubGlobal('crypto', { subtle: { decrypt: realDecrypt } });
    vi.stubGlobal('window', {
      postMessage: (msg, origin) => posted.push({ msg, origin }),
      location: { origin: ORIGIN },
    });
    vi.resetModules();
    await import('../ialertSessionSpy.js');
    return globalThis.crypto.subtle.decrypt;
  }

  afterEach(() => vi.unstubAllGlobals());

  it('a decrypted login response posts exactly one IALERT_SESSION with string fields', async () => {
    const decrypt = await loadSpy(async () => enc(LOGIN).buffer);
    await decrypt({}, {}, new Uint8Array());
    expect(posted).toHaveLength(1);
    expect(posted[0].origin).toBe(ORIGIN);
    expect(posted[0].msg).toEqual({
      type: 'IALERT_SESSION',
      token: 'ACCESS-T',
      refreshToken: 'REFRESH-T',
      tokenValue: '179226993000200002',
      ialertUserId: '200002',
      ialertOwnerId: '200002',
    });
  });

  it('a decrypted refresh response posts IALERT_ROTATED', async () => {
    const decrypt = await loadSpy(async () =>
      enc({ data: { token: 'NEW-A', refresh_token: 'NEW-R' } }).buffer,
    );
    await decrypt({}, {}, new Uint8Array());
    expect(posted.map((p) => p.msg)).toEqual([
      { type: 'IALERT_ROTATED', token: 'NEW-A', refreshToken: 'NEW-R' },
    ]);
  });

  it('unrelated or non-JSON plaintext posts nothing', async () => {
    let next = enc('not json').buffer;
    const decrypt = await loadSpy(async () => next);
    await decrypt({}, {}, new Uint8Array());
    next = enc({ data: [{ vin: 'X' }] }).buffer;
    await decrypt({}, {}, new Uint8Array());
    expect(posted).toHaveLength(0);
  });

  it("returns the page's own result unchanged, and decrypts exactly once", async () => {
    const buf = enc(LOGIN).buffer;
    const decrypt = await loadSpy(async () => buf);
    const out = await decrypt({}, {}, new Uint8Array());
    expect(out).toBe(buf);
    expect(realDecrypt).toHaveBeenCalledTimes(1);
  });

  it("a failing page decrypt rejects to the page unchanged and is not retried", async () => {
    const boom = new Error('OperationError');
    const decrypt = await loadSpy(async () => {
      throw boom;
    });
    await expect(decrypt({}, {}, new Uint8Array())).rejects.toBe(boom);
    expect(realDecrypt).toHaveBeenCalledTimes(1);
    expect(posted).toHaveLength(0);
  });
});

describe('ialertSessionReader (real module)', () => {
  let onWindowMessage;
  let onRuntimeMessage;
  let sent;

  async function loadReader() {
    sent = [];
    const win = {
      addEventListener: (type, fn) => {
        if (type === 'message') onWindowMessage = fn;
      },
    };
    vi.stubGlobal('window', win);
    vi.stubGlobal('chrome', {
      runtime: {
        id: 'ext-id',
        sendMessage: (m) => sent.push(m),
        onMessage: { addListener: (fn) => (onRuntimeMessage = fn) },
      },
    });
    vi.resetModules();
    await import('../ialertSessionReader.js');
    return win;
  }

  const session = (tokenValue) => ({
    type: 'IALERT_SESSION',
    token: `T-${tokenValue}`,
    refreshToken: null,
    tokenValue,
    ialertUserId: '1',
    ialertOwnerId: '1',
  });

  beforeEach(async () => {
    await loadReader();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forwards a same-window, same-origin session to the background', () => {
    onWindowMessage({ source: window, origin: ORIGIN, data: session('1792285412001') });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('IALERT_SESSION_CAPTURED');
    expect(sent[0].session.tokenValue).toBe('1792285412001');
  });

  it('ignores a wrong origin, a foreign source and a wrong type', () => {
    onWindowMessage({ source: window, origin: 'https://evil.example', data: session('1792285412001') });
    onWindowMessage({ source: {}, origin: ORIGIN, data: session('1792285412001') });
    onWindowMessage({ source: window, origin: ORIGIN, data: { type: 'OTHER' } });
    expect(sent).toHaveLength(0);
  });

  it('keeps the freshest session by the token_value epoch prefix', () => {
    onWindowMessage({ source: window, origin: ORIGIN, data: session('1792285412001') });
    onWindowMessage({ source: window, origin: ORIGIN, data: session('1792285000001') }); // older
    expect(sent).toHaveLength(1);
    let answer;
    const handled = onRuntimeMessage({ type: 'READ_IALERT_SESSION' }, { id: 'ext-id' }, (r) => (answer = r));
    expect(handled).toBe(false);
    expect(answer.session.tokenValue).toBe('1792285412001');
  });

  it('accepts a different session when token_value has no comparable epoch prefix', () => {
    onWindowMessage({ source: window, origin: ORIGIN, data: session('1792285412001') });
    onWindowMessage({ source: window, origin: ORIGIN, data: session('abc') });
    expect(sent).toHaveLength(2);
    onWindowMessage({ source: window, origin: ORIGIN, data: session('abc') }); // same again
    expect(sent).toHaveLength(2);
  });

  it('answers READ_IALERT_SESSION only for this extension', () => {
    let answer = 'untouched';
    onRuntimeMessage({ type: 'READ_IALERT_SESSION' }, { id: 'other-ext' }, (r) => (answer = r));
    expect(answer).toBe('untouched');
  });
});
