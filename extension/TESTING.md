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

When you run `git push origin Devayan`, the `.husky/pre-push` hook automatically runs from the repository root:

```bash
cd extension
npm run lint   # ESLint
npm test       # Vitest
```

If **either linting or tests fail**, the push is blocked. You must fix the issues and try again.

### To Bypass (Not Recommended)

```bash
# Force push without running hooks (use sparingly!)
git push --no-verify origin Devayan
```

### Tests Match Reality

The test suite tests the **actual working implementation** (tab injection via `chrome.scripting.executeScript`). All **187 tests pass** (2 skipped) across **9 files**:

| File | Tests | Coverage |
|------|------:|----------|
| `utils.test.js` | 16 | Pure functions: retries, time conversion, JWT parsing |
| `backendApi.test.js` | 19 | Backend API calls, error codes, auth state management |
| `fleetedgeApi.test.js` | 20 | Tab injection, endpoint validation, error handling |
| `taskPoller.test.js` | 12 | Poll cycles, VIN resolution, IST ↔ UTC conversion |
| `integration.test.js` | 13 | End-to-end flows: login → tasks → submit, auth lifecycle |
| `telemetry.test.js` | 45 | LEMU telemetry: 7-layer logger, batching, error tracking |
| `logger.test.js` | 6 | Buffered logging, module names, limits |
| **`edge-cases-utils.test.js`** | **46** | **Error boundaries for all utility functions** |
| **`edge-cases-integration.test.js`** | **9** | **Module-level edge cases: timeout, 401 clear, VIN fallback** |

---

## Test Structure

All test files live inside the module they test, under a `__tests__` directory:

```
src/background/
├── __tests__/
│   ├── utils.test.js                  ← pure-function tests (no Chrome API)
│   ├── logger.test.js                 ← buffered logger, storage interactions
│   ├── fleetedgeApi.test.js           ← fetch mocking, API error handling
│   ├── backendApi.test.js             ← backend fetch helpers, fire-and-forget
│   ├── taskPoller.test.js             ← poll-cycle integration, VIN resolution
│   ├── integration.test.js            ← end-to-end multi-module flows
│   ├── telemetry.test.js              ← LEMU telemetry collector tests
│   ├── edge-cases-utils.test.js       ← error boundaries (pure functions)
│   └── edge-cases-integration.test.js ← error boundaries (mocked modules)
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

## Why Edge Cases Matter — Tests You Must NOT Skip

Edge-case tests (`edge-cases-utils.test.js` and `edge-cases-integration.test.js`) are the **most important tests in the suite**. Each group prevents a specific production failure:

### Pure Function Edge Cases (46 tests)

| Test Group | Tests | WHY THIS MATTERS |
|------------|------:|-------------------|
| **decodeJwtPayload — malformed tokens** | 7 | Corrupted JWTs from FleetEdge must not crash the extension. Garbage in → `null` out, never an exception. |
| **redactToken — short/empty tokens** | 6 | Tokens shorter than 10 chars must still redact safely for logging without exposing secrets. |
| **normalizeRegistration — special chars** | 8 | Indian plates come with dots, dashes, spaces, slashes. `MH.12-AB 1234` must normalize to `MH12AB1234`. Bug fixed: was only stripping spaces/dashes, now strips ALL non-alphanumeric. |
| **buildUtcWindow — midnight/timezone edge** | 5 | IST midnight (00:00) converts to previous day in UTC (18:30). Off-by-one-day bugs corrupt fuel data windows. |
| **checkTokenExpiry — invalid exp** | 9 | String `exp` values, `null`, `0`, and already-expired tokens must all return `{ valid: false }`. Bug fixed: was accepting string exp values. |
| **withRetry — 401/403 immediate throw** | 4 | Auth errors must NOT be retried — retrying a 401 wastes time and can trigger rate limiting. |
| **istToUtc — invalid dates** | 3 | Garbage date strings must return `null`, not `Invalid Date` strings that silently flow downstream. |
| **formatUtcDatetime — null/edge values** | 4 | `null`, empty string, and epoch-zero must produce safe fallback output. |

### Integration Edge Cases (9 tests)

| Test Group | Tests | WHY THIS MATTERS |
|------------|------:|-------------------|
| **timedFetch timeout** | 1 | Without timeout, a hung backend makes the extension wait **forever**. AbortController must fire. |
| **login missing token** | 1 | Backend returning `{ data: {} }` (no token) must throw, not silently store `undefined`. |
| **401 clears auth state** | 1 | Expired JWT must clear stored auth — otherwise user is stuck in an infinite re-login loop. |
| **empty vehicles response** | 1 | Backend returning `{ data: {} }` (no vehicles array) must return `[]`, not crash on `.map()`. |
| **multiple FleetEdge tabs** | 1 | Extension must consistently pick the first tab, not randomly select one. |
| **null executeScript result** | 1 | If tab injection returns null (page not ready), extension must throw a clear error. |
| **VIN last-4 fallback** | 1 | When exact registration match fails, last-4-digit matching prevents task failure for non-standard registrations. |
| **missing vehicle_number** | 1 | Tasks arriving without `vehicle_number` must report a validation error, not crash the poller. |
| **zero fuel_used** | 1 | `fuel_used: 0` is valid data (idle vehicle) — must be submitted, not filtered as falsy. |

### Real Bugs Caught by Edge Cases

1. **`normalizeRegistration` keeping dots/slashes** — Regex was `/[\s-]/g` (only spaces + dashes). Indian plates with dots (`MH.12.AB.1234`) and slashes passed through unstripped. Fixed: `/[^a-zA-Z0-9]/g`.

2. **`checkTokenExpiry` accepting string exp** — `if (!exp)` missed the case where `exp` is a non-empty string like `"invalid"`. The comparison `exp < now` with a string returns `false`, so expired tokens appeared valid. Fixed: added `typeof exp !== 'number'` check.

Both bugs were **caught by edge-case tests first**, then fixed in the source code.

### Mock Isolation Pattern (`vi.doMock`)

The integration edge-case file uses `vi.doMock()` instead of `vi.mock()` because:

- `vi.mock()` is **hoisted** to file scope — it affects ALL tests in the file
- `vi.doMock()` is **not hoisted** — it only applies after `vi.resetModules()`
- Each `describe` block gets its own helper function (`setupBackendApi`, `setupFleetedgeApi`, `setupTaskPoller`) that sets up fresh mocks

This pattern is the correct way to test modules with different mock configurations in the same file.

---

## What Is NOT Tested Here

| Scope | Reason |
|-------|--------|
| `tokenCapture.js` | Relies on `chrome.webRequest` — best tested with Playwright or a manual flow |
| `index.js` (message router) | Thin orchestration layer; covered implicitly by taskPoller tests |
| React popup components | UI components require a DOM environment (jsdom) — add with `@testing-library/react` if needed |
| Extension load / manifest | Chrome's own extension validation covers this at `chrome://extensions` |

---

## Smoke Tests (Playwright)

A headed Chromium smoke test loads the built extension from `dist/` and verifies the popup renders without console errors:

```bash
cd extension
npm run build          # build first — smoke test needs dist/
npm run test:smoke     # runs e2e/smoke.spec.js
```

The smoke test:
1. Launches Chromium with `--load-extension=dist/`.
2. Opens the extension action popup.
3. Asserts the popup `<div>` is visible.
4. Captures the first `ERROR` / `WARN` console message (if any) in the test output.
5. Saves a screenshot on failure or on completion.

This is also run in CI via the `smoke.yml` workflow.

---

## Continuous Integration

The CI pipeline is defined in `.github/workflows/`:

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `validate.yml` | PR, push to `main` | Lint (`npm run lint`) + test (`npm test`) + build (`npm run build`) |
| `smoke.yml` | PR, push to `main` | Build extension, then run Playwright smoke test |
| `codeql.yml` | PR, push to `main`, schedule | Security analysis (`analyze (javascript)`) |
| `dependency-review.yml` | PRs targeting `main` | Scans dependency changes for known vulnerabilities |

All four workflows must pass before merging into `main`. The `validate.yml` job name is `build-and-test`, which is one of the required status checks for branch protection.

### Security Audits (Local)

Run the full security pre-flight locally before any CWS submission:

```bash
cd extension
npm run check:security   # runs check-manifest + check-secrets in sequence
```

| Script | Purpose |
|--------|---------|
| `npm run check:manifest` | Validates MV3 manifest against CWS policy (no `tabs`, no `http://`, version matches, etc.) |
| `npm run check:secrets`  | Greps `dist/` for hardcoded secrets: JWT-looking tokens, API keys, password hints, AWS/Azure secrets |

These scripts are also run in CI via `validate.yml` (manifest check) and `security-audit.yml` (secret scan).
