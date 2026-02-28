# Testing Guide

This document explains how to run, extend, and interpret the test suite for the FleetEdge Fuel Monitor Chrome Extension.

---

## Quick Start

```bash
cd extension

# Install dependencies (first time only)
npm install

# Run all tests once
npm test

# Watch mode — re-runs on every save
npm run test:watch

# Run with coverage report
npm run test:coverage
```

Coverage output is written to `coverage/` as both an HTML report (`coverage/index.html`) and a text summary in the terminal.

---

## Pre-Push Quality Gates (Husky)

This repository uses [Husky](https://typicode.github.io/husky/) to enforce code quality before pushing to GitHub.

### What Happens on `git push`

When you run `git push origin main`, the `.husky/pre-push` hook automatically runs from the repository root:

```bash
cd extension
npm run lint   # ESLint
npm test       # Vitest
```

If **either linting or tests fail**, the push is blocked. You must fix the issues and try again.

### To Bypass (Not Recommended)

```bash
# Force push without running hooks (use sparingly!)
git push --no-verify origin main
```

### Tests Match Reality

The test suite has been updated to test the **actual working implementation** (tab injection via `chrome.scripting.executeScript`). All **55 tests pass**:

- `fleetedgeApi.test.js` (17 tests) — Tab injection, endpoint validation, error handling  
- `taskPoller.test.js` (9 tests) — Poll cycles, VIN resolution, IST ↔ UTC conversion  
- `backendApi.test.js` (7 tests) — Backend API calls, error codes, fire-and-forget logging  
- `utils.test.js` (16 tests) — Pure functions: retries, time conversion, JWT parsing  
- `logger.test.js` (6 tests) — Buffered logging, module names, limits  

---

## Test Structure

All test files live inside the module they test, under a `__tests__` directory:

```
src/background/
├── __tests__/
│   ├── utils.test.js        ← pure-function tests (no Chrome API)
│   ├── logger.test.js       ← buffered logger, storage interactions
│   ├── fleetedgeApi.test.js ← fetch mocking, API error handling
│   ├── backendApi.test.js   ← backend fetch helpers, fire-and-forget
│   └── taskPoller.test.js   ← poll-cycle integration, VIN resolution
```

Tests are discovered by the glob pattern in `vite.config.js`:

```js
include: ['src/**/__tests__/**/*.test.js']
```

---

## Technology Stack

| Tool | Purpose |
|------|---------|
| [Vitest](https://vitest.dev/) | Test runner (Vite-native, fast) |
| `@vitest/coverage-v8` | Branch/line coverage via V8 |
| `vi.mock()` | Module-level dependency replacement |
| `vi.stubGlobal()` | Replace `chrome`, `fetch`, etc. at test time |
| `vi.useFakeTimers()` | Freeze `Date.now()` in expiry tests |

The environment is set to `node` — no browser DOM emulation is needed since background modules are pure JavaScript.

---

## Chrome API Mocking Pattern

All background modules only touch `chrome` inside function bodies (never at import time).
This means you can set up the global stub at the top of each test file before importing the module under test:

```js
vi.stubGlobal('chrome', {
  storage: {
    local: {
      get: vi.fn(() => Promise.resolve({})),
      set: vi.fn(() => Promise.resolve()),
    },
  },
  alarms: {
    create: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  },
});

// Import AFTER the stub is in place
const { myFunction } = await import('../myModule.js');
```

> **Note:** Use dynamic `await import()` for modules that read `chrome` during initialisation (e.g. `logger.js`), so that the stub is guaranteed to be installed first.

---

## Config Mocking

Every background module imports config as:

```js
import { config } from './config.js';
```

Always mock with the **lower-case** key:

```js
vi.mock('../config.js', () => ({
  config: {
    MAX_RETRY_ATTEMPTS: 3,
    CVP_API_BASE: 'https://cvp.api.tatamotors',
    // ... only the fields the module-under-test actually uses
  },
}));
```

Using `CONFIG` (uppercase) as the mock key will silently fail — all config reads will return `undefined`.

---

## Writing New Tests

1. Create a file in the appropriate `__tests__/` directory ending in `.test.js`.
2. Stub `chrome` and other globals at the top of the file.
3. Mock external modules with `vi.mock()` **before** importing the module under test.
4. Import the module under test with `await import()` (dynamic import, so stubs are resolved first).
5. Write `describe` / `it` blocks using [Vitest's API](https://vitest.dev/api/).

### Template

```js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Stub globals
vi.stubGlobal('chrome', { /* ... */ });

// 2. Mock dependencies
vi.mock('../config.js', () => ({ config: { MY_SETTING: 'value' } }));
vi.mock('../logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// 3. Import module under test (after stubs & mocks)
const { myExport } = await import('../myModule.js');

beforeEach(() => { vi.clearAllMocks(); });

describe('myExport', () => {
  it('does the right thing', async () => {
    // arrange
    // act
    const result = await myExport('input');
    // assert
    expect(result).toBe('expected');
  });
});
```

---

## Coverage Targets

After running `npm run test:coverage`, open `coverage/index.html` in a browser to see a detailed line-by-line breakdown.

The coverage config only tracks production source files:

```
include: ['src/background/*.js']
exclude: ['src/background/__tests__/**']
```

Aim for **≥ 80 % statement coverage** on `utils.js`, `fleetedgeApi.js`, and `backendApi.js`. The `taskPoller.js` poll-cycle path is harder to unit-test fully because it orchestrates multiple services — integration/E2E tests are more appropriate for its end-to-end behaviour.

---

## What Is NOT Tested Here

| Scope | Reason |
|-------|--------|
| `tokenCapture.js` | Relies on `chrome.webRequest` — best tested with Playwright or a manual flow |
| `index.js` (message router) | Thin orchestration layer; covered implicitly by taskPoller tests |
| React popup components | UI components require a DOM environment (jsdom) — add with `@testing-library/react` if needed |
| Extension load / manifest | Chrome's own extension validation covers this at `chrome://extensions` |

---

## Continuous Integration

To run tests in CI (GitHub Actions example):

```yaml
- name: Test
  working-directory: extension
  run: |
    npm ci
    npm test
```

Add `npm run test:coverage` and upload the `coverage/` artifact if you want coverage tracking over time.
