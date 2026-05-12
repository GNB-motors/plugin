import { config } from './config.js';

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const CURRENT_LOG_LEVEL = LOG_LEVELS.DEBUG;
const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 10;
const MAX_LOG_ENTRIES = config?.LOG_RETENTION_COUNT ?? 500;

let buffer = [];
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flushBuffer, FLUSH_INTERVAL_MS);
}

async function flushBuffer() {
  flushTimer = null;
  if (buffer.length === 0) return;

  const batch = buffer.splice(0);

  try {
    const store = await chrome.storage.local.get(['logs']);
    const entries = store.logs || [];
    entries.push(...batch);

    if (entries.length > MAX_LOG_ENTRIES) {
      entries.splice(0, entries.length - MAX_LOG_ENTRIES);
    }

    await chrome.storage.local.set({ logs: entries });
  } catch (err) {
    console.error('Log flush failed:', err);
  }
}

class Logger {
  constructor(module) {
    this.module = module;
  }

  _log(level, levelName, ...args) {
    if (level < CURRENT_LOG_LEVEL) return;

    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${levelName}] [${this.module}]`;

    console[levelName.toLowerCase()](prefix, ...args);

    buffer.push({
      timestamp: Date.now(),
      level: levelName,
      module: this.module,
      message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '),
    });

    if (buffer.length >= FLUSH_THRESHOLD) {
      flushBuffer();
    } else {
      scheduleFlush();
    }
  }

  debug(...args) { this._log(LOG_LEVELS.DEBUG, 'DEBUG', ...args); }
  info(...args)  { this._log(LOG_LEVELS.INFO, 'INFO', ...args); }
  warn(...args)  { this._log(LOG_LEVELS.WARN, 'WARN', ...args); }
  error(...args) { this._log(LOG_LEVELS.ERROR, 'ERROR', ...args); }
}

export function createLogger(module) {
  return new Logger(module);
}

export async function getLogs(limit = 100) {
  await flushBuffer();
  const store = await chrome.storage.local.get(['logs']);
  return (store.logs || []).slice(-limit);
}

export async function clearLogs() {
  buffer = [];
  await chrome.storage.local.remove(['logs']);
}
