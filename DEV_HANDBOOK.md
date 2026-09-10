# GNB Edge Plugin — Developer Handbook

> **Target audience:** Engineers working on the Chrome extension, local test server, or backend integration.
>
> **Last updated:** 2026-05-13 | **Commit:** 65de906 (partially refreshed 2026-09-10 — version
> numbers, env config, branch strategy, and the testing-strategy table were corrected; other
> sections may still describe the pre-multi-account architecture. `extension/README.md` is the
> current source of truth for anything not covered here.)

---

## Table of Contents

1. [Development Environment Setup](#1-development-environment-setup)
2. [Project Structure Deep Dive](#2-project-structure-deep-dive)
3. [Development Workflow](#3-development-workflow)
4. [Architecture Patterns](#4-architecture-patterns)
5. [Testing Strategy](#5-testing-strategy)
6. [Code Style & Conventions](#6-code-style--conventions)
7. [Debugging](#7-debugging)
8. [Release Process](#8-release-process)
9. [Chrome Web Store Submission](#9-chrome-web-store-submission)
10. [Common Tasks](#10-common-tasks)
11. [Troubleshooting](#11-troubleshooting)

---

## 1. Development Environment Setup

### Prerequisites

```bash
# Check versions
node --version    # >= 18.0.0
npm --version     # >= 9.0.0
chrome --version  # >= 109.0.0
```

### Initial Setup

```bash
# Clone / navigate to project
cd plugin       # the repo root — wherever you cloned/unzipped it

# Install extension dependencies
cd extension
npm install

# Install root dependencies (for local test server)
cd ..
npm install
```

### Environment Configuration

```bash
cd extension
cp .env.example .env
# Edit .env with your settings
```

**For development** — set your backend URL in `.env`, e.g.:

```env
VITE_BACKEND_BASE_URL=http://localhost:3000/v1
```

The `/v1` suffix is required — the real API 405s without it (the API version
lives in the path, not a header).

**For production builds — you don't set this yourself.** `extension/.env.production`
is committed and points at `https://api.app.gnbedge.in/v1`; Vite loads it in
production mode and it overrides whatever `.env` says. `npm run build` /
`build:zip` are safe by default even if `.env` still points at a dev box —
see `extension/README.md`, "Install · develop · build".

---

## 2. Project Structure Deep Dive

### Extension (`extension/`)

#### Manifest V3 (`manifest.json`)

The single source of truth for Chrome about what this extension is and what it can do:

```json
{
  "manifest_version": 3,
  "name": "gnbedge",
  "version": "0.0.0.4",
  "permissions": ["storage", "alarms", "notifications", "browsingData"],
  "host_permissions": ["https://api.app.gnbedge.in/*"],
  "optional_host_permissions": [
    "https://fleetedge.home.tatamotors/*",
    "https://cvpauth.api.tatamotors/*"
  ],
  "background": {
    "service_worker": "src/background/index.js",
    "type": "module"
  },
  "content_scripts": [
    {
      "matches": ["https://fleetedge.home.tatamotors/*"],
      "js": ["src/content/networkSpy.js"],
      "run_at": "document_start",
      "world": "MAIN"
    },
    {
      "matches": ["https://fleetedge.home.tatamotors/*"],
      "js": ["src/content/fleetedgeTokenReader.js"],
      "run_at": "document_idle",
      "world": "ISOLATED"
    }
  ]
}
```

**Key design decisions:**

- `world: "MAIN"` for `networkSpy.js` — runs in the page's own JS context so it can intercept `window.fetch` and `XMLHttpRequest`
- `world: "ISOLATED"` for `fleetedgeTokenReader.js` — runs in extension's isolated world with access to `chrome.runtime` APIs
- Communication between them uses `window.postMessage` (cross-world bridge)
- `"type": "module"` — enables ES modules in the service worker (Chrome 109+)

#### Service Worker (`src/background/`)

| File | Lines | Responsibility |
|------|------:|----------------|
| `index.js` | ~334 | Message router, alarm handler, lifecycle |
| `backendApi.js` | ~153 | Auth, authenticated fetch, timeout handling |
| `fleetedgeLink.js` | ~273 | Token capture flow, account management |
| `telemetry.js` | ~505 | LEMU 7-layer telemetry system |
| `logger.js` | ~80 | Namespaced logging with retention |
| `utils.js` | ~120 | Storage wrappers, JWT parsing, helpers |
| `config.js` | ~22 | Environment-driven constants |

#### Popup UI (`src/popup/`)

| File | Lines | Responsibility |
|------|------:|----------------|
| `Popup.jsx` | ~635 | Main React component — all UI logic |
| `Popup.css` | ~1063 | All styles (no CSS-in-JS) |

**Why no state management library?** The popup is ephemeral — it opens, loads state from `chrome.storage.local`, renders, and closes. All persistent state lives in the service worker and `chrome.storage`.

---

## 3. Development Workflow

### Branch Strategy

This diagram is stale — see `AGENTS.md`'s "Active branches" for the current,
correct picture. Short version: feature branches (`feat/<slug>`, `fix/<slug>`,
etc.) branch directly off `main` and PR back to `main`. `Devayan` and `plugin`
are older lines that fed into `main` historically; **do not branch off either.**

### Daily Development Loop

```bash
# 1. Start local test server (terminal 1) — from the repo root
npm start

# 2. Start extension dev server (terminal 2)
cd extension
npm run dev

# 3. Load extension in Chrome
#    chrome://extensions/ → Load unpacked → select extension/ folder

# 4. Make changes → Vite HMR updates popup automatically
#    Service worker changes require: chrome://extensions/ → 🔄 Reload

# 5. Run tests
npm test

# 6. Commit
#    Husky pre-commit hooks run linting automatically
```

### Hot Reload Behavior

| What Changed | Required Action |
|--------------|----------------|
| `Popup.jsx`, `Popup.css` | Auto-HMR in dev server |
| `src/background/*.js` | Click 🔄 Reload in `chrome://extensions/` |
| `manifest.json` | Click 🔄 Reload in `chrome://extensions/` |
| `src/content/*.js` | Refresh the FleetEdge tab |

### Testing Against Real Backend

```bash
# Switch your local .env to a real backend (dev box or prod)
echo 'VITE_BACKEND_BASE_URL=https://your-backend.example.com/v1' > extension/.env
cd extension && npm run build
# Load dist/ folder in chrome://extensions/
```

To test specifically against **prod**, you don't need to touch `.env` at all —
`npm run build` already targets prod via the committed `.env.production` (see
"Environment Configuration" above).

---

## 4. Architecture Patterns

### Pattern: Message-Based Communication

The popup and service worker communicate exclusively via `chrome.runtime.sendMessage`:

```javascript
// Popup → Service Worker
const response = await chrome.runtime.sendMessage({
  type: 'CONNECT_FLEETEDGE'
});
// response: { success: true, accountId, vehicleCount, ... }
```

```javascript
// Service Worker → Popup (background → popup is NOT direct)
// Instead, popup polls storage on open:
const store = await chrome.storage.local.get(['fleetEdgeAccounts']);
```

**Why not long-lived ports?** Ports break when the popup closes. Message passing + storage is more robust for ephemeral UIs.

### Pattern: Status Cache Deduplication

```javascript
// index.js — prevents 4 concurrent status requests
const STATUS_CACHE_TTL_MS = 10_000;
let _statusPromise = null;
let _statusCacheTime = 0;

async function getCachedFleetEdgeStatus() {
  const now = Date.now();
  if (_statusPromise && (now - _statusCacheTime) < STATUS_CACHE_TTL_MS) {
    return _statusPromise; // Return in-flight promise
  }
  _statusCacheTime = now;
  _statusPromise = getFleetEdgeStatus().catch((err) => {
    _statusPromise = null; // Clear on error
    throw err;
  });
  return _statusPromise;
}
```

This pattern is critical because status can be requested simultaneously by:
- The 2-minute alarm
- Post-login fire-and-forget
- Manual refresh button
- Popup open

### Pattern: Layered Telemetry (LEMU)

Every significant action is logged with a layer + severity:

```javascript
import { record, LAYERS } from './telemetry.js';

record(LAYERS.BACKEND, 'INFO', 'FleetEdge linked', {
  accountId: result.accountId,
  vehicleCount: result.vehicleCount
});
```

**7 Layers:**

| Layer | Use For |
|-------|---------|
| `UI` | Button clicks, form submissions |
| `MESSAGE` | sendMessage types, handler entry/exit |
| `BACKEND` | API calls, responses, errors |
| `FLEETEDGE` | Token capture, link/unlink, status |
| `STORAGE` | chrome.storage operations |
| `TOKEN` | JWT read, decode, expiry checks |
| `TASK` | Process triggers, task results |

**Severities:** DEBUG < INFO < WARN < ERROR < FATAL

Only WARN+ is shipped to the backend (batched, every 60s).

### Pattern: Graceful Degradation

```javascript
// fleetedgeLink.js — status check falls back to cache
try {
  const response = await backendFetch('/fleetedge/status');
  const data = await response.json();
  await setStorage({ fleetEdgeAccounts: data.accounts });
  return data;
} catch (err) {
  // Use cached data instead of failing
  const store = await getStorage(['fleetEdgeAccounts']);
  return { accounts: store.fleetEdgeAccounts || [] };
}
```

---

## 5. Testing Strategy

### Test Architecture

See `extension/TESTING.md` for the authoritative, current table (12 files,
covering `src/background/`, `src/content/`, and `src/popup/` — this table
covered only `background/` and had drifted from the real per-file counts).

**Total: 277 tests pass, 2 skipped** (the same two "custom `backendUrl` from
storage" cases skipped intentionally, in `backendApi.test.js` and
`integration.test.js`).

### Running Tests

```bash
# All tests
npx vitest run

# Watch mode (re-run on file change)
npx vitest

# With coverage
npx vitest run --coverage

# Single file
npx vitest run src/background/__tests__/backendApi.test.js

# Filter by test name
npx vitest run -t "should handle timeout"
```

### Writing New Tests

```javascript
// src/background/__tests__/myFeature.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { myFunction } from '../myModule.js';

describe('myFeature', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chrome API mocks
    global.chrome = {
      storage: { local: { get: vi.fn(), set: vi.fn() } },
      runtime: { sendMessage: vi.fn() },
    };
  });

  it('should do the thing', async () => {
    const result = await myFunction('input');
    expect(result).toEqual({ success: true });
  });
});
```

### Mocking Chrome APIs

The test suite uses a shared mock factory:

```javascript
// In your test setup
const makeStore = () => ({
  'authToken': 'test_token',
  'authUser': { name: 'Test User', role: 'OWNER' },
  'fleetEdgeAccounts': [],
});
```

See `edge-cases-v2.test.js` for the canonical chrome mock setup.

---

## 6. Code Style & Conventions

### Linting

```bash
npm run lint        # Check
npm run lint -- --fix   # Auto-fix
```

ESLint config: `extension/eslint.config.js` — extends `@eslint/js/recommended` + React hooks rules.

### Naming Conventions

| What | Pattern | Example |
|------|---------|---------|
| Files | kebab-case | `fleetedge-link.js` (but we use camelCase for existing) |
| Functions | camelCase | `connectFleetEdge()` |
| Constants | SCREAMING_SNAKE | `STATUS_CACHE_TTL_MS` |
| Private vars | leading underscore | `_statusPromise` |
| React components | PascalCase | `Popup.jsx` |
| CSS classes | kebab-case with `gnb-` prefix | `gnb-card`, `gnb-connectivity` |

### JSDoc

All exported functions should have JSDoc:

```javascript
/**
 * Connect a new FleetEdge account.
 * Captures token from open tab, links to backend.
 * @returns {Promise<{success: boolean, accountId?: string, error?: string}>}
 */
export async function connectFleetEdge() { ... }
```

### Error Handling

Always return structured errors from message handlers:

```javascript
// Good
return { success: false, error: 'FleetEdge token not found — please log in first' };

// Bad
tthrow new Error('something broke');
```

The popup expects `{ success: boolean, error?: string, ...data }` for all responses.

---

## 7. Debugging

### Chrome DevTools for Service Worker

1. Go to `chrome://extensions/`
2. Find GNB Edge → Click **"service worker"** link
3. This opens DevTools for the service worker context
4. **Console** — see logs from `logger.js`
5. **Network** — inspect backend API calls
6. **Application → Storage → Local Storage** — inspect `chrome.storage.local`

### Popup DevTools

1. Click the extension icon to open popup
2. Right-click inside popup → **Inspect**
3. Or: In service worker DevTools, click the popup URL in the console

### Content Script DevTools

1. Open FleetEdge tab
2. Open DevTools (F12)
3. **Console** — see messages from both MAIN and ISOLATED worlds
4. To distinguish: MAIN world logs have `[FleetEdge Interceptor]` prefix

### Debug Logging

Enable verbose logging:

```javascript
// In console (service worker context)
chrome.storage.local.set({ 'debugMode': true });
```

All `logger.debug()` calls will then appear in the console.

### Telemetry Debug

```javascript
// Get all telemetry events
chrome.runtime.sendMessage({ type: 'GET_TELEMETRY' })
  .then(r => console.table(r.events));

// Get health snapshot
chrome.runtime.sendMessage({ type: 'GET_HEALTH' })
  .then(r => console.log(r.health));
```

---

## 8. Release Process

### Version Bump

1. Update version in `extension/manifest.json`
2. Update `extension/CHANGELOG.md`
3. Commit: `git commit -m "chore(release): bump vX.Y.Z"`
4. **Tag the commit you actually submit to CWS**: `git tag -a vX.Y.Z -m "Release vX.Y.Z"`.
   This isn't optional bookkeeping — `check-manifest-policy.cjs`'s monotonic-version check
   reads `git describe --tags --abbrev=0` first and only falls back to `HEAD~1` if no tag
   exists. Skip the tag and a same-version follow-up commit (e.g. a docs fix after the
   release commit) makes the check compare a version against itself and fail on nothing real.
5. Push: `git push origin main --tags`

### Build Checklist

```bash
cd extension

# 1. Lint
npm run lint

# 2. Test
npm run test

# 3. Build
npm run build

# 4. Verify manifest in dist/
cat dist/manifest.json | grep version

# 5. Package (Node zip writer — no PowerShell/zip dependency; forward slashes, not backslashes)
npm run build:zip
# Output: extension-vX.Y.Z.zip, matching manifest.json's version

# 6. Regenerate the CWS screenshots + promo tile from the real built popup, if the UI changed
npm run build:screenshots
```

### Pre-Release Verification

- [ ] All tests pass
- [ ] Lint clean
- [ ] Popup loads without console errors
- [ ] Login flow works
- [ ] FleetEdge connect works
- [ ] Status polling shows correct data
- [ ] Disconnect works
- [ ] Badge updates correctly
- [ ] Notifications fire on expiry

---

## 9. Chrome Web Store Submission

### Required Assets

| Asset | Spec | Location |
|-------|------|----------|
| Icons | 16×16, 48×48, 128×128 PNG | `public/icons/` |
| Screenshots | 1280×800 or 640×400 JPEG/PNG | Upload during submission |
| Promo tile | 440×280 JPEG/PNG | Optional |
| Privacy policy | HTML page | `public/privacy.html` |

### CWS Fields

- **Title:** GNB Edge — FleetEdge Fuel Monitor
- **Category:** Productivity
- **Language:** English
- **Description:** See `CWS_SUBMISSION.md` (pre-written)

### Submission Steps

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole/)
2. Click **"New Item"**
3. Upload `extension-vX.Y.Z.zip`
4. Fill in store listing details
5. Select **"Unlisted"** visibility (link-only; see `CWS_SUBMISSION.md` for why not Public yet — the Tata Motors host permission risks trademark rejection)
6. Add trusted testers
7. Submit for review

**Review time:** Typically 1-3 business days for private extensions.

### Post-Submission

- Monitor **"Status"** in the developer dashboard
- If rejected, read the rejection reason, fix, rebuild, re-upload
- Common rejections: missing privacy policy, broad permissions explanation

---

## 10. Common Tasks

### Add a New Message Type

1. **Service Worker** (`index.js`):

```javascript
case 'MY_NEW_ACTION': {
  const { param } = message;
  const result = await doSomething(param);
  return { success: true, result };
}
```

2. **Popup** (`Popup.jsx`):

```javascript
const handleMyAction = async () => {
  setLoading(true);
  const response = await chrome.runtime.sendMessage({
    type: 'MY_NEW_ACTION',
    param: 'value'
  });
  if (response.success) {
    // Handle success
  } else {
    setError(response.error);
  }
  setLoading(false);
};
```

3. **Test** (new or existing test file):

```javascript
it('should handle MY_NEW_ACTION', async () => {
  const response = await handleMessage({ type: 'MY_NEW_ACTION', param: 'test' });
  expect(response.success).toBe(true);
});
```

### Add a New Backend Endpoint Call

1. Add to `backendApi.js`:

```javascript
export async function fetchNewData(param) {
  const response = await backendFetch('/new-endpoint', {
    method: 'POST',
    body: JSON.stringify({ param })
  });
  return response.json();
}
```

2. Wire into `index.js` message handler or call directly from popup.

### Update Local Test Server

Edit `server.js`:

```javascript
// Add new endpoint
app.get('/api/my-new-route', requireAuth, (req, res) => {
  res.json({ data: 'hello' });
});
```

Restart: `Ctrl+C` then `npm start` (no hot reload for server).

---

## 11. Troubleshooting

### Tests fail with "chrome is not defined"

You forgot to mock the Chrome API. Add to your test:

```javascript
global.chrome = {
  storage: { local: { get: vi.fn(), set: vi.fn() } },
  runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
  alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
};
```

### Build fails with "Cannot find module"

Vite may have cached old paths:

```bash
rm -rf extension/dist extension/node_modules/.vite
cd extension && npm run build
```

### Extension shows "Invalid manifest"

- Check JSON validity: `cat extension/manifest.json | python3 -m json.tool`
- Ensure `"manifest_version": 3`
- Ensure `"type": "module"` in background if using ES imports

### Service worker shows "undefined" errors

Service workers don't have `window` object. Use `self` or global scope:

```javascript
// Bad
window.myVar = 1;

// Good
self.myVar = 1;
// Or just
globalThis.myVar = 1;
```

### FleetEdge token not found

1. Open FleetEdge, log in
2. Navigate to dashboard (triggers API calls)
3. Check DevTools → Network — do you see XHR/fetch with `Authorization: Bearer`?
4. If yes, check content script is injected:
   - `chrome://extensions/` → Service Worker → Console
   - Look for: `[FleetEdge Fuel Monitor] Initialized...`

---

## Appendix A: File Sizes (Built)

```bash
cd extension
npm run build
du -sh dist/
for f in dist/assets/*; do echo "$(gzip -c "$f" | wc -c) $f"; done | sort -n
```

`@crxjs/vite-plugin` hashes every output filename (e.g.
`index.html-Cl-paZ5k.js`), so there's no fixed `background.js`/`popup.js` to
name — re-run the commands above for current numbers rather than trusting a
table. As measured on the 0.0.0.4 build (gzipped):

| File | Size (gzipped) | What it roughly is |
|------|---------------:|---|
| `networkSpy.js-*.js` | ~1 KB | Content script, MAIN world |
| `fleetedgeTokenReader.js-*.js` | ~3 KB | Content script, ISOLATED world |
| `index-*.css` | ~4 KB | Popup styles |
| `index.js-*.js` | ~9 KB | Service worker entry |
| `index.html-*.js` | ~67 KB | Popup bundle (React + app code) |
| **Total unpacked** | **~190 KB** | `du -sh dist/` |

---

## Appendix B: Useful Chrome URLs

| URL | Purpose |
|-----|---------|
| `chrome://extensions/` | Manage extensions |
| `chrome://serviceworker-internals/` | Debug service workers |
| `chrome://net-export/` | Network log export |
| `chrome://policy/` | Enterprise policies |

---

*Questions? Check [ARCHITECTURE.mmd](./ARCHITECTURE.mmd) for diagrams or [README.md](./README.md) for user-facing docs.*
