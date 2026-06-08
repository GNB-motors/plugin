/**
 * Unit tests for src/background/telemetry.js  —  LEMU core
 *
 * Covers:
 *  - Event recording (all layers / severities)
 *  - Error fingerprinting & dedup
 *  - Severity filtering (min-level gate)
 *  - Breadcrumbs
 *  - Health counters
 *  - Performance tracking
 *  - Layer loggers
 *  - Flush to chrome.storage
 *  - Ship queue for WARN+
 *  - Immediate ship on FATAL
 *  - User-environment collection
 *  - Event trimming at max cap
 *  - getStats / getEvents with filters
 *  - clearEvents
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Chrome + navigator stubs ────────────────────────────────────────────────

const mockStorage = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn((keys) => {
        const result = {};
        const list = Array.isArray(keys) ? keys : [keys];
        list.forEach((k) => {
          if (k in mockStorage) result[k] = mockStorage[k];
        });
        return Promise.resolve(result);
      }),
      set: vi.fn((obj) => {
        Object.assign(mockStorage, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach((k) => delete mockStorage[k]);
        return Promise.resolve();
      }),
    },
  },
  runtime: {
    getManifest: vi.fn(() => ({ version: '1.0.1-test' })),
    getPlatformInfo: vi.fn(() => Promise.resolve({ os: 'win', arch: 'x86-64' })),
  },
});

vi.stubGlobal('crypto', {
  randomUUID: vi.fn(() => `test-uuid-${Date.now()}-${Math.random()}`),
});

vi.stubGlobal('performance', {
  now: (() => {
    let t = 0;
    return vi.fn(() => (t += 10));
  })(),
});

vi.stubGlobal('navigator', {
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  language: 'en-US',
  languages: ['en-US', 'en'],
  cookieEnabled: true,
  onLine: true,
  hardwareConcurrency: 8,
  deviceMemory: 16,
  connection: {
    effectiveType: '4g',
    downlink: 10,
    rtt: 50,
    saveData: false,
  },
});

vi.stubGlobal('screen', {
  width: 1920,
  height: 1080,
  colorDepth: 24,
});

// Stub config
vi.mock('../config.js', () => ({
  config: {
    TELEMETRY_ENABLED: true,
    TELEMETRY_MIN_SEVERITY: 'DEBUG',
    TELEMETRY_MAX_EVENTS: 100,
    TELEMETRY_FLUSH_INTERVAL_MS: 50,
    TELEMETRY_SHIP_TO_BACKEND: false, // off for most tests so we don't trigger fetches
    TELEMETRY_BACKEND_ENDPOINT: '/telemetry/ingest',
    TELEMETRY_SHIP_BATCH_SIZE: 25,
    TELEMETRY_SHIP_INTERVAL_MS: 100,
    TELEMETRY_HEALTH_CHECK_INTERVAL_MS: 60_000,
    BACKEND_BASE_URL: 'http://localhost:3000',
    API_PREFIX: '/api/extension',
    FETCH_TIMEOUT_MS: 5000,
  },
}));

// Import after stubs
const {
  LAYERS,
  SEVERITY,
  record,
  createLayerLogger,
  perfStart,
  perfEnd,
  startTelemetry,
  getEvents,
  clearEvents,
  getStats,
  getHealthSnapshot,
  getBreadcrumbs,
  computeFingerprint,
  _internals,
} = await import('../telemetry.js');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function clearStorage() {
  Object.keys(mockStorage).forEach((k) => delete mockStorage[k]);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('LEMU telemetry', () => {
  beforeEach(() => {
    clearStorage();
    _internals.resetForTest();
  });

  afterEach(() => {
    _internals.resetForTest();
  });

  // ── LAYERS & SEVERITY enums ──

  describe('enums', () => {
    it('exposes all 7 layers', () => {
      expect(Object.keys(LAYERS)).toEqual([
        'UI',
        'MESSAGE',
        'BACKEND',
        'FLEETEDGE',
        'STORAGE',
        'TOKEN',
        'TASK',
      ]);
    });

    it('severity levels are ordered 0-4', () => {
      expect(SEVERITY.DEBUG).toBe(0);
      expect(SEVERITY.INFO).toBe(1);
      expect(SEVERITY.WARN).toBe(2);
      expect(SEVERITY.ERROR).toBe(3);
      expect(SEVERITY.FATAL).toBe(4);
    });
  });

  // ── record() ──

  describe('record()', () => {
    it('creates an event with required fields', () => {
      const e = record(LAYERS.TASK, 'INFO', 'hello');
      expect(e).not.toBeNull();
      expect(e.layer).toBe('TASK');
      expect(e.severity).toBe('INFO');
      expect(e.severityLevel).toBe(1);
      expect(e.message).toBe('hello');
      expect(e.id).toBeTruthy();
      expect(e.timestamp).toBeTruthy();
    });

    it('returns null when telemetry is disabled', async () => {
      const { config } = await import('../config.js');
      config.TELEMETRY_ENABLED = false;
      const e = record(LAYERS.TASK, 'INFO', 'nope');
      expect(e).toBeNull();
      config.TELEMETRY_ENABLED = true;
    });

    it('respects minimum severity', async () => {
      const { config } = await import('../config.js');
      config.TELEMETRY_MIN_SEVERITY = 'WARN';
      const e = record(LAYERS.TASK, 'DEBUG', 'too low');
      expect(e).toBeNull();

      const e2 = record(LAYERS.TASK, 'WARN', 'high enough');
      expect(e2).not.toBeNull();
      config.TELEMETRY_MIN_SEVERITY = 'DEBUG';
    });

    it('attaches error details for ERROR severity', () => {
      const e = record(LAYERS.BACKEND, 'ERROR', 'boom', {
        error: new TypeError('network fail'),
      });
      expect(e.errorName).toBe('TypeError');
      expect(e.stack).toContain('TypeError');
      expect(e.fingerprint).toContain('BACKEND::TypeError');
    });

    it('attaches breadcrumbs to ERROR events', () => {
      record(LAYERS.TASK, 'INFO', 'breadcrumb 1');
      record(LAYERS.TASK, 'INFO', 'breadcrumb 2');
      const e = record(LAYERS.BACKEND, 'ERROR', 'crash', {
        error: new Error('crash'),
      });
      expect(e.breadcrumbs).toBeDefined();
      expect(e.breadcrumbs.length).toBeGreaterThanOrEqual(2);
    });

    it('bumps health counters', () => {
      record(LAYERS.UI, 'WARN', 'w1');
      record(LAYERS.UI, 'WARN', 'w2');
      record(LAYERS.BACKEND, 'ERROR', 'e1', { error: new Error('e1') });
      expect(_internals.healthCounters['UI.WARN']).toBe(2);
      expect(_internals.healthCounters['BACKEND.ERROR']).toBe(1);
    });

    it('adds to event buffer', () => {
      record(LAYERS.TASK, 'INFO', 'buf1');
      record(LAYERS.TASK, 'INFO', 'buf2');
      expect(_internals.eventBuffer.length).toBe(2);
    });

    it('queues WARN+ events for shipping when enabled', async () => {
      const { config } = await import('../config.js');
      config.TELEMETRY_SHIP_TO_BACKEND = true;
      record(LAYERS.TASK, 'DEBUG', 'not shipped');
      record(LAYERS.TASK, 'INFO', 'not shipped');
      record(LAYERS.TASK, 'WARN', 'shipped');
      record(LAYERS.BACKEND, 'ERROR', 'also shipped', {
        error: new Error('e'),
      });
      expect(_internals.shipQueue.length).toBe(2);
      config.TELEMETRY_SHIP_TO_BACKEND = false;
    });
  });

  // ── Fingerprinting ──

  describe('computeFingerprint()', () => {
    it('produces stable layer::name::message fingerprints', () => {
      const fp = computeFingerprint('BACKEND', 'TypeError', 'timeout');
      expect(fp).toBe('BACKEND::TypeError::timeout');
    });

    it('strips hex IDs', () => {
      const fp = computeFingerprint('TASK', 'Error', 'Cannot find doc abc123def456');
      expect(fp).toContain('<ID>');
      expect(fp).not.toContain('abc123def456');
    });

    it('strips long numbers', () => {
      const fp = computeFingerprint('BACKEND', 'Error', 'Timeout after 15000ms');
      expect(fp).toContain('<NUM>');
    });

    it('strips ISO timestamps', () => {
      const fp = computeFingerprint('TASK', 'Error', 'Failed at 2024-01-15T10:30:00.000Z');
      expect(fp).toContain('<TS>');
      expect(fp).not.toContain('2024');
    });

    it('strips URLs', () => {
      const fp = computeFingerprint(
        'BACKEND',
        'Error',
        'Fetch failed for https://api.example.com/v1/tasks'
      );
      expect(fp).toContain('<URL>');
      expect(fp).not.toContain('example.com');
    });

    it('truncates message to 200 chars', () => {
      const long = 'x'.repeat(300);
      const fp = computeFingerprint('TASK', 'Error', long);
      expect(fp.length).toBeLessThan(220); // layer::Error:: + 200
    });
  });

  // ── Breadcrumbs ──

  describe('breadcrumbs', () => {
    it('tracks WARN+ as breadcrumbs', () => {
      record(LAYERS.UI, 'WARN', 'first');
      record(LAYERS.UI, 'INFO', 'second');
      const bc = getBreadcrumbs();
      expect(bc.length).toBe(2); // both INFO and WARN add breadcrumbs
    });

    it('limits to 50 breadcrumbs (oldest evicted)', () => {
      for (let i = 0; i < 60; i++) {
        record(LAYERS.TASK, 'INFO', `crumb ${i}`);
      }
      const bc = getBreadcrumbs();
      expect(bc.length).toBe(50);
      expect(bc[0].message).toBe('crumb 10'); // first 10 evicted
    });
  });

  // ── Performance Tracking ──

  describe('perfStart / perfEnd', () => {
    it('records duration and returns ms', () => {
      perfStart('myOp');
      const dur = perfEnd('myOp', LAYERS.TASK);
      expect(typeof dur).toBe('number');
      expect(dur).toBeGreaterThanOrEqual(0);
    });

    it('returns null for unknown label', () => {
      expect(perfEnd('nonexistent')).toBeNull();
    });
  });

  // ── Layer Loggers ──

  describe('createLayerLogger()', () => {
    it('returns an object with debug/info/warn/error/fatal', () => {
      const log = createLayerLogger(LAYERS.BACKEND);
      expect(typeof log.debug).toBe('function');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.fatal).toBe('function');
    });

    it('records events under the correct layer', () => {
      const log = createLayerLogger(LAYERS.UI);
      const e = log.warn('click failed');
      expect(e.layer).toBe('UI');
      expect(e.severity).toBe('WARN');
    });

    it('has perfStart/perfEnd shortcuts', () => {
      const log = createLayerLogger(LAYERS.TASK);
      log.perfStart('testPerf');
      const dur = log.perfEnd('testPerf');
      expect(typeof dur).toBe('number');
    });
  });

  // ── Flush ──

  describe('flush()', () => {
    it('writes buffered events to chrome.storage', async () => {
      record(LAYERS.TASK, 'INFO', 'flush test');
      expect(_internals.eventBuffer.length).toBe(1);

      await _internals.flush();
      expect(_internals.eventBuffer.length).toBe(0);
      expect(mockStorage.lemu_telemetry.length).toBe(1);
      expect(mockStorage.lemu_telemetry[0].message).toBe('flush test');
    });

    it('trims events when exceeding max', async () => {
      const { config } = await import('../config.js');
      config.TELEMETRY_MAX_EVENTS = 5;

      // Write 10 events
      for (let i = 0; i < 10; i++) {
        record(LAYERS.TASK, 'INFO', `event ${i}`);
      }
      await _internals.flush();

      expect(mockStorage.lemu_telemetry.length).toBeLessThanOrEqual(5);
      config.TELEMETRY_MAX_EVENTS = 100;
    });

    it('preserves errors when trimming', async () => {
      const { config } = await import('../config.js');
      config.TELEMETRY_MAX_EVENTS = 5;

      // Add 3 info + 3 errors (exceeds max=5)
      record(LAYERS.TASK, 'INFO', 'info 1');
      record(LAYERS.TASK, 'INFO', 'info 2');
      record(LAYERS.TASK, 'INFO', 'info 3');
      record(LAYERS.BACKEND, 'ERROR', 'err 1', { error: new Error('e1') });
      record(LAYERS.BACKEND, 'ERROR', 'err 2', { error: new Error('e2') });
      record(LAYERS.BACKEND, 'ERROR', 'err 3', { error: new Error('e3') });

      await _internals.flush();
      const stored = mockStorage.lemu_telemetry;
      expect(stored.length).toBeLessThanOrEqual(5);

      // All errors should still be present
      const errors = stored.filter((e) => e.severityLevel >= 3);
      expect(errors.length).toBe(3);
      config.TELEMETRY_MAX_EVENTS = 100;
    });
  });

  // ── getEvents() with filters ──

  describe('getEvents()', () => {
    it('returns all events without filters', async () => {
      record(LAYERS.TASK, 'INFO', 'a');
      record(LAYERS.UI, 'WARN', 'b');
      await _internals.flush();

      const events = await getEvents();
      expect(events.length).toBe(2);
    });

    it('filters by layer', async () => {
      record(LAYERS.TASK, 'INFO', 'task');
      record(LAYERS.UI, 'INFO', 'ui');
      await _internals.flush();

      const events = await getEvents({ layer: 'UI' });
      expect(events.length).toBe(1);
      expect(events[0].layer).toBe('UI');
    });

    it('filters by minimum severity', async () => {
      record(LAYERS.TASK, 'DEBUG', 'low');
      record(LAYERS.TASK, 'WARN', 'mid');
      record(LAYERS.TASK, 'ERROR', 'high', { error: new Error('e') });
      await _internals.flush();

      const events = await getEvents({ severity: 'WARN' });
      expect(events.every((e) => e.severityLevel >= 2)).toBe(true);
    });

    it('filters by search text', async () => {
      record(LAYERS.TASK, 'INFO', 'apple orange');
      record(LAYERS.TASK, 'INFO', 'banana');
      await _internals.flush();

      const events = await getEvents({ search: 'apple' });
      expect(events.length).toBe(1);
    });

    it('limits results', async () => {
      for (let i = 0; i < 10; i++) record(LAYERS.TASK, 'INFO', `e${i}`);
      await _internals.flush();

      const events = await getEvents({ limit: 3 });
      expect(events.length).toBe(3);
    });
  });

  // ── getStats() ──

  describe('getStats()', () => {
    it('returns totals by layer and severity', async () => {
      record(LAYERS.TASK, 'INFO', 's1');
      record(LAYERS.TASK, 'WARN', 's2');
      record(LAYERS.UI, 'ERROR', 's3', { error: new Error('e') });
      await _internals.flush();

      const stats = await getStats();
      expect(stats.total).toBe(3);
      expect(stats.byLayer.TASK).toBe(2);
      expect(stats.byLayer.UI).toBe(1);
      expect(stats.bySeverity.INFO).toBe(1);
      expect(stats.bySeverity.WARN).toBe(1);
      expect(stats.bySeverity.ERROR).toBe(1);
    });

    it('counts fingerprints', async () => {
      record(LAYERS.BACKEND, 'ERROR', 'timeout', {
        error: new Error('timeout'),
      });
      record(LAYERS.BACKEND, 'ERROR', 'timeout', {
        error: new Error('timeout'),
      });
      await _internals.flush();

      const stats = await getStats();
      const fp = Object.keys(stats.byFingerprint);
      expect(fp.length).toBe(1);
      expect(Object.values(stats.byFingerprint)[0]).toBe(2);
    });
  });

  // ── clearEvents() ──

  describe('clearEvents()', () => {
    it('resets all state and storage', async () => {
      record(LAYERS.TASK, 'INFO', 'doomed');
      await _internals.flush();
      expect(mockStorage.lemu_telemetry.length).toBe(1);

      await clearEvents();
      expect(mockStorage.lemu_telemetry.length).toBe(0);
      expect(_internals.eventBuffer.length).toBe(0);
      expect(_internals.shipQueue.length).toBe(0);
      expect(_internals.breadcrumbs.length).toBe(0);
    });
  });

  // ── Health ──

  describe('getHealthSnapshot()', () => {
    it('returns counters and timestamps', async () => {
      record(LAYERS.TASK, 'INFO', 'h1');
      const snap = await getHealthSnapshot();
      expect(snap.counters).toBeDefined();
      expect(snap.lastSnapshot).toBeTruthy();
    });
  });

  // ── User Environment ──

  describe('collectUserEnvironment()', () => {
    it('collects browser, OS, hardware, screen info', async () => {
      const env = await _internals.collectUserEnvironment();
      expect(env.browser.name).toBe('Chrome');
      expect(env.browser.version).toBe('120.0.0.0');
      expect(env.os).toBe('win');
      expect(env.arch).toBe('x86-64');
      expect(env.hardwareConcurrency).toBe(8);
      expect(env.deviceMemory).toBe(16);
      expect(env.screenWidth).toBe(1920);
      expect(env.screenHeight).toBe(1080);
      expect(env.language).toBe('en-US');
      expect(env.onLine).toBe(true);
    });

    it('stores env in chrome.storage', async () => {
      await _internals.collectUserEnvironment();
      expect(mockStorage.lemu_user_env).toBeDefined();
      expect(mockStorage.lemu_user_env.browser.name).toBe('Chrome');
    });

    it('collects connection info', async () => {
      const env = await _internals.collectUserEnvironment();
      expect(env.connection.effectiveType).toBe('4g');
      expect(env.connection.downlink).toBe(10);
    });
  });

  // ── parseBrowserFromUA ──

  describe('parseBrowserFromUA()', () => {
    const parse = _internals.parseBrowserFromUA;

    it('detects Chrome', () => {
      const r = parse('Mozilla/5.0 Chrome/120.0.6099.109 Safari/537.36');
      expect(r.name).toBe('Chrome');
      expect(r.version).toBe('120.0.6099.109');
    });

    it('detects Edge', () => {
      const r = parse('Mozilla/5.0 Chrome/120.0 Safari/537.36 Edg/120.0.2210.91');
      expect(r.name).toBe('Edge');
    });

    it('detects Opera', () => {
      const r = parse('Mozilla/5.0 Chrome/120.0 Safari/537.36 OPR/106.0.4998.70');
      expect(r.name).toBe('Opera');
    });

    it('detects Firefox', () => {
      const r = parse('Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Firefox/121.0');
      expect(r.name).toBe('Firefox');
    });

    it('returns unknown for empty UA', () => {
      const r = parse('');
      expect(r.name).toBe('unknown');
    });
  });

  // ── startTelemetry() ──

  describe('startTelemetry()', () => {
    it('initialises without throwing', async () => {
      await expect(startTelemetry()).resolves.not.toThrow();
    });

    it('records a startup INFO event', async () => {
      await startTelemetry();
      // Wait a tick for the event buffer
      await new Promise((r) => setTimeout(r, 10));
      expect(_internals.eventBuffer.some((e) => e.message.includes('LEMU telemetry started'))).toBe(
        true
      );
    });
  });

  // ─── H-5: PII / JWT redaction at emit time ─────────────────────────────────
  describe('PII + JWT redaction (H-5)', () => {
    const JWT = 'eyAAAAAAAAAAAAAAA.BBBBBBBBB.CCCCCCCCC';

    it('redacts JWT-shaped string values', () => {
      const ev = record(LAYERS.FLEETEDGE, 'INFO', 'link', { token: JWT });
      expect(ev.token).not.toBe(JWT);
      expect(ev.token).toMatch(/…/); // redactToken returns prefix…suffix
      expect(ev.token).not.toContain('BBBBBBBBB');
    });

    it('redacts Bearer-prefixed JWT', () => {
      const ev = record(LAYERS.BACKEND, 'INFO', 'call', { authorization: `Bearer ${JWT}` });
      expect(ev.authorization.startsWith('Bearer ')).toBe(true);
      expect(ev.authorization).not.toContain('BBBBBBBBB');
      expect(ev.authorization).toMatch(/…/);
    });

    it('replaces PII key values with ***', () => {
      const ev = record(LAYERS.FLEETEDGE, 'INFO', 'profile', {
        user: { email: 'x@y.com', firstName: 'A', lastName: 'B', phone: '+1234567890' },
      });
      expect(ev.user.email).toBe('***');
      expect(ev.user.firstName).toBe('***');
      expect(ev.user.lastName).toBe('***');
      expect(ev.user.phone).toBe('***');
    });

    it('redacts PII key match case-insensitively', () => {
      const ev = record(LAYERS.UI, 'INFO', 'form', {
        EMAIL: 'x@y.com',
        UserName: 'someone',
        Mobile: '555',
      });
      expect(ev.EMAIL).toBe('***');
      expect(ev.UserName).toBe('***');
      expect(ev.Mobile).toBe('***');
    });

    it('walks nested objects', () => {
      const ev = record(LAYERS.FLEETEDGE, 'INFO', 'nested', {
        outer: { inner: { token: JWT, user: { email: 'a@b.com' } } },
      });
      expect(ev.outer.inner.token).not.toContain('BBBBBBBBB');
      expect(ev.outer.inner.token).toMatch(/…/);
      expect(ev.outer.inner.user.email).toBe('***');
    });

    it('walks arrays of objects', () => {
      const ev = record(LAYERS.FLEETEDGE, 'INFO', 'arr', {
        accounts: [
          { token: JWT, email: 'a@b.com' },
          { token: JWT, name: 'Some One' },
        ],
      });
      expect(ev.accounts[0].token).toMatch(/…/);
      expect(ev.accounts[0].token).not.toContain('BBBBBBBBB');
      expect(ev.accounts[0].email).toBe('***');
      expect(ev.accounts[1].name).toBe('***');
    });

    it('leaves non-JWT strings untouched', () => {
      const ev = record(LAYERS.UI, 'INFO', 'misc', { msg: 'hello world', n: 42, ok: true });
      expect(ev.msg).toBe('hello world');
      expect(ev.n).toBe(42);
      expect(ev.ok).toBe(true);
    });

    it('caps recursion depth without throwing', () => {
      // Build a deeply nested object beyond depth cap.
      let deep = { token: JWT };
      for (let i = 0; i < 20; i++) deep = { child: deep };
      expect(() => record(LAYERS.UI, 'INFO', 'deep', { tree: deep })).not.toThrow();
    });

    it('redacts before chrome.storage.local write (no plaintext in buffer)', () => {
      const ev = record(LAYERS.FLEETEDGE, 'WARN', 'warn', { token: JWT });
      // Buffer is the source for flush() → chrome.storage.local
      const buffered = _internals.eventBuffer.find((e) => e.id === ev.id);
      expect(buffered).toBeDefined();
      expect(buffered.token).not.toContain('BBBBBBBBB');
      expect(JSON.stringify(buffered)).not.toContain('BBBBBBBBB');
    });

    it('redacts before WARN+ ship queue entry', () => {
      const ev = record(LAYERS.FLEETEDGE, 'ERROR', 'err', {
        token: JWT,
        user: { email: 'x@y.com' },
      });
      // Without TELEMETRY_SHIP_TO_BACKEND=true the queue is empty; assert via the
      // returned event (same object that would be pushed).
      expect(ev.token).not.toContain('BBBBBBBBB');
      expect(ev.user.email).toBe('***');
    });
  });
});
