/**
 * Unit tests for src/background/logger.js
 *
 * chrome.storage.local is stubbed globally because the logger only accesses
 * chrome inside the lazy flushBuffer() call — never at module-load time.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Chrome stub ─────────────────────────────────────────────────────────────
const mockStorage = {};
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn((keys) => {
        const result = {};
        (Array.isArray(keys) ? keys : [keys]).forEach(k => {
          if (k in mockStorage) result[k] = mockStorage[k];
        });
        return Promise.resolve(result);
      }),
      set: vi.fn((obj) => {
        Object.assign(mockStorage, obj);
        return Promise.resolve();
      }),
      remove: vi.fn((keys) => {
        (Array.isArray(keys) ? keys : [keys]).forEach(k => delete mockStorage[k]);
        return Promise.resolve();
      }),
    },
  },
});

vi.mock('../config.js', () => ({
  config: { LOG_RETENTION_COUNT: 200 },
}));

// Import AFTER the chrome stub is in place
const { createLogger, getLogs, clearLogs } = await import('../logger.js');

describe('logger', () => {
  beforeEach(() => {
    Object.keys(mockStorage).forEach(k => delete mockStorage[k]);
  });

  describe('createLogger', () => {
    it('returns an object with info / warn / error / debug methods', () => {
      const log = createLogger('TestModule');
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.debug).toBe('function');
    });

    it('does not throw when logging strings', () => {
      const log = createLogger('TestModule');
      expect(() => log.info('hello')).not.toThrow();
      expect(() => log.warn('hmm')).not.toThrow();
      expect(() => log.error('oops')).not.toThrow();
      expect(() => log.debug('detail')).not.toThrow();
    });

    it('includes the module name in logged entries', async () => {
      const log = createLogger('MyMod');
      log.info('test message');
      // Flush via getLogs (which reads from buffered entries before they persist)
      const entries = await getLogs(10);
      const found = entries.some(e => e.module === 'MyMod' && e.message.includes('test message'));
      expect(found).toBe(true);
    });
  });

  describe('getLogs', () => {
    it('returns an array', async () => {
      const result = await getLogs(10);
      expect(Array.isArray(result)).toBe(true);
    });

    it('respects the limit parameter', async () => {
      const log = createLogger('LimitTest');
      for (let i = 0; i < 15; i++) log.info(`entry ${i}`);
      const result = await getLogs(5);
      expect(result.length).toBeLessThanOrEqual(5);
    });
  });

  describe('clearLogs', () => {
    it('empties the log store', async () => {
      const log = createLogger('ClearTest');
      log.info('before clear');
      await clearLogs();
      const remaining = await getLogs(100);
      // After clear, only entries buffered after the clear should exist
      const beforeClear = remaining.filter(e => e.message === 'before clear');
      expect(beforeClear).toHaveLength(0);
    });
  });
});
