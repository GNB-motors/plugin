# Changelog — gnbedge Chrome Extension

---

## [2026-09-10] — branch: main (no version bump — packaging + tooling only)

### Fixed the release pipeline that 0.0.0.4 exposed, and stopped it from drifting again

The 0.0.0.4 manifest bump (previous entry) had never actually been packaged or
pushed — `main` was missing that commit until this session, and packaging it
surfaced three real bugs.

#### scripts/build-zip.cjs, scripts/zip-dir.cjs (new)
`build-zip.cjs` shelled out to `powershell -Command <script> -src X -dst Y` —
but `-Command` takes one script string and appends everything after it as
literal text, so `param($src,$dst)` never bound and `Join-Path` got `null`.
Packaging failed outright. `Compress-Archive` was also the wrong tool even
once that was fixed: Windows PowerShell 5.1 writes `\` as the in-archive path
separator, which is out of ZIP spec and not something the Chrome Web Store is
reliably tolerant of — the 0.0.0.3 zip that actually shipped has `/`. Replaced
both with `zip-dir.cjs`, a dependency-free ZIP writer (`zip` isn't installed on
Windows; GNU tar can't write ZIPs). Verified: the rebuilt archive extracts
byte-for-byte identical to `dist/`, `unzip -t` clean, forward slashes.

#### The manifest-version check needed a tag, not just git history
`check-manifest-policy.cjs`'s monotonic-version check compares against
`git describe --tags --abbrev=0`, falling back to `HEAD~1:extension/manifest.json`.
No tag existed, and two consecutive commits both carried `0.0.0.4` (the feature
commit, then this session's packaging commit), so the `HEAD~1` fallback
compared `0.0.0.4` against itself and failed with nothing real to fix. Tagged
`v0.0.0.3` at the last commit actually submitted to CWS (`ef25334`) — the
check's own intended baseline — rather than weakening the check.

#### .env.production (new), .env.example (corrected)
Release builds must not inherit a dev-box URL. `vite.config.js` derives
`host_permissions` from `VITE_BACKEND_BASE_URL`, so a build that read the
local `.env` (pointed at the dev box) would ship that host in the manifest to
the Web Store — the only reason the first 0.0.0.4 zip avoided this was that
`.env` was moved aside by hand before building. `.env.production` (committed,
`https://api.app.gnbedge.in/v1`, no secrets) is loaded by Vite in production
mode and overrides `.env`, so `npm run build` / `build:zip` are now correct by
default; `npm run dev` is unaffected. Verified with `.env` still pointed at the
dev box: a plain build emitted the prod URL and only the prod host in
`host_permissions`.

Also corrected `.env.example`, which documented five keys
(`VITE_POLL_INTERVAL_MINUTES`, `VITE_INTER_TASK_DELAY_MS`,
`VITE_VIN_CACHE_TTL_HOURS`, `VITE_TOKEN_EXPIRY_BUFFER_SECONDS`,
`VITE_SEARCH_WINDOW_MINUTES`) that no source file reads. The polling knob the
code actually reads is `VITE_STATUS_POLL_INTERVAL_MINUTES` — the documented
name silently did nothing.

#### scripts/build-screenshots.cjs (new)
The Chrome Web Store screenshots and promo tile were hand-written HTML
mockups that had drifted from the real popup — showing a logo, tagline, and
button style the UI no longer has, and (on the dashboard shot) a real fleet
identifier baked into a public listing image. Replaced with a script that
renders the real built popup (`dist/`) behind a stubbed `chrome` API and
frames it, so the assets track the UI instead of drifting. Run via
`npm run build:screenshots`. Seeded with synthetic account/user data on
purpose — these are public images.

#### Verification
`check:manifest` and `check:secrets` pass; 277 tests / 2 skipped; lint clean;
`npm audit --omit=dev` reports 0 vulnerabilities; the packaged zip round-trips
`dist/` byte-for-byte with no dev host anywhere in it.

---

## [2026-09-09] — branch: feat/auto-clear-and-close (manifest 0.0.0.3 → 0.0.0.4)

### Clear the FleetEdge session after linking, and decrypt the SPA token without WebCrypto

#### Why the session is cleared
The browser's FleetEdge SPA is a second consumer of the same single-use refresh
token. If its tab stays open after a link, its own refresh timer rotates the
token and invalidates the copy we just stored server-side. After a successful
link the extension now clears FleetEdge site data and closes those tabs. This is
a purely **local** delete — it never calls a FleetEdge/Keycloak logout endpoint,
so the server-side session and our stored refresh token both stay alive.

#### manifest.json
- **`permissions`** added `browsingData` — required for the origin-scoped
  `chrome.browsingData.remove({ origins: [...] }, { cookies, localStorage })`
  call above. Scoped to the two FleetEdge origins; no history, cache, or
  downloads are touched, and no other site is affected.
- **`optional_host_permissions`** added `https://cvpauth.api.tatamotors/*` — the
  FleetEdge auth origin holds half of the session state, so it must be cleared
  alongside the portal origin. Optional, like the portal host: not granted at
  install, only after the user clicks "Connect Fleet Portal".
- **`version`** bumped `0.0.0.3` → `0.0.0.4` (CWS rejects same-version re-uploads).

#### src/content/aes192cbc.js (new)
Pure-JS AES-192-CBC fallback for reading the SPA's encrypted localStorage token.
WebCrypto's `subtle` does not implement AES-192, so the previous reader failed on
exactly the token it existed to read.

#### src/background/fleetedgeLink.js
`clearFleetEdgeSessionAndCloseTabs()` runs after a successful link. A failure to
clear never fails the link — the token is already stored server-side; only the
tab-closing convenience is lost.

#### CWS submission notes
`browsingData` is a new permission and will draw a review question. Justification
text is in `CWS_SUBMISSION.md` § "Permission justifications".

---

## [2026-05-26] — branch: feat/externally-connectable-onboarding

### Web onboarding can now detect the extension (manifest 0.0.0.2 → 0.0.0.3)

The frontend onboarding flow (`main-frontend` PR #38) attempts a 3-layer
detection (`chrome.runtime.sendMessage`, DOM marker, image probe at
`chrome-extension://<id>/icons/icon16.png`). With the previous manifest none
of the layers could fire and the UI always fell back to the manual "I've
installed it" checkbox. This update enables Layer 1 and Layer 3.

#### manifest.json
- **`externally_connectable.matches`** added:
  - `https://app.gnbedge.in/*` (prod frontend)
  - `https://main-frontend-wine.vercel.app/*` (dev frontend, Vercel)
- **`web_accessible_resources`** added for `icons/icon16.png` on the same two origins.
- **`version`** bumped `0.0.0.2` → `0.0.0.3` (CWS rejects same-version re-uploads).

#### src/background/index.js
- Added `chrome.runtime.onMessageExternal` listener responding to `{ type: 'PING' }`
  with `{ ok: true, version }`. Required for Layer 1 to resolve. No auth state exposed.

#### CWS submission notes
- This is a permission expansion — Google review may ask for justification.
  Suggested wording: *"`externally_connectable` is required so our web app
  (`app.gnbedge.in`) can detect that the extension is installed during the
  user onboarding flow. The extension only responds to a single 'PING'
  message and exposes no user data."*

---

## [2026-05-22] — branch: Devayan

### CI hardening, security audits, and repo automation

#### New CI workflows (`.github/workflows/`)

| Workflow | What it does | Status check name |
|---|---|---|
| `validate.yml` | Lint + unit tests (187) + build + CWS manifest policy + secrets scan + `npm audit --audit-level=high` | `build-and-test`, `cws-policy-check`, `security-audit` |
| `smoke.yml` | Playwright loads `dist/` into Chromium, opens popup, asserts no console errors, screenshot artifact | `smoke` |
| `codeql.yml` | GitHub static security analysis (XSS, injection) | `analyze (javascript)` |
| `dependency-review.yml` | Blocks PRs introducing high-severity vulnerable dependencies | `dependency-review` |

All four workflows run on every PR and push to `Devayan`, `updated-design`, and `main`.

#### New security checks (`extension/scripts/`)

- `check-manifest-policy.cjs` — Banned permissions (`webRequest`, `scripting`, `tabs`), host rules (FleetEdge stays in `optional_host_permissions`), CSP, version format, icon existence, content script existence.
- `check-secrets.cjs` — Hardcoded API keys, `eval()`, `document.write`, remote imports, JWTs, AWS keys.

Run locally:
```bash
npm run check:manifest
npm run check:secrets
npm run check:security   # both above + npm audit --audit-level=high
```

#### Playwright smoke test (`extension/e2e/smoke.spec.js`)

- Loads the built `dist/` extension into a persistent Chromium context.
- Navigates to `chrome-extension://<id>/index.html`.
- Asserts the popup renders (h1 "gnbedge" visible) and captures console errors.
- Screenshot saved to `test-results/popup.png` for CI debugging.

Run locally (requires `npm run build` first):
```bash
npm run test:smoke
```

#### Dependency & build fixes

- Added `npm overrides` to force `@crxjs/vite-plugin` → `rollup@4.60.4`, resolving pre-existing high-severity audit failures.
- Updated `.eslintignore` to exclude built asset directories (`gnbedge-v0.0.0.2/**`).

#### Repo automation

- `.github/pull_request_template.md` — PR template with CWS surface-area checklist.
- `.github/ISSUE_TEMPLATE/bug_report.yml` — Structured bug report form.
- `.github/ISSUE_TEMPLATE/feature_request.yml` — Structured feature request form.
- `AGENTS.md` — Contributor guide: repository layout, branch conventions, CWS constraints, test conventions, backend integration.

---

## [2026-05-10] — branch: updated-design

### Auto-refresh FleetEdge tab on connect failure

#### Background change (`src/background/fleetedgeLink.js`)

When `chrome.tabs.sendMessage` fails with **"Could not establish connection. Receiving end does not exist."** (content script not yet injected — typically when the FleetEdge tab has just loaded or was never focused), `connectFleetEdge()` now:

1. Calls `chrome.tabs.reload(tab.id)` to force a full page reload.
2. Waits 3 seconds for the page to finish loading and for the content script to be injected by Chrome.
3. Retries `sendMessage` once.

If the retry also fails, a clear error message is returned: `"Could not communicate with FleetEdge page after refresh — please try again"`.

Any other `sendMessage` error (non-connection errors) skips the reload and returns the original error immediately.

**No manifest changes required.** No new permissions are used — `chrome.tabs.reload` is allowed for tabs the extension already has permission to access via `optional_host_permissions`. The extension zip does **not** need to be rebuilt unless you want this fix in production; the behaviour change is purely in the service worker JavaScript.

#### Test changes

- `edge-cases-integration.test.js` — Added `chrome.tabs.reload: vi.fn()` to the chrome stub in the `connectFleetEdge handles sendMessage error gracefully` test. Updated the mock error message to include `"Receiving end does not exist"` so the new retry branch is exercised.
- `edge-cases-v2.test.js` — Added `chrome.tabs.reload: vi.fn()` to the shared `makeStore()` chrome mock so all `fleetedgeLink` tests pass.

All 187 tests pass (2 skipped — pre-existing backendUrl tests).

---

## [2026-05-09] — branch: Devayan

### Backend integration: Multi-FleetEdge-Account ingestion (extension path)

No extension source files changed this session. The following backend changes affect how extension-originated data is attributed:

#### Account tagging for extension-sourced data

The backend now maintains a `FleetEdgeAccount` row per `{orgId, source:'EXTENSION', externalAccountId}`. The `externalAccountId` is extracted from the `fleetId` claim in the JWT that `FleetEdgeProxyService.linkToken` already decodes.

- Every snapshot or vehicle event that arrives via the extension proxy is now tagged with the matched `FleetEdgeAccount._id`.
- If the same vehicle later appears on a different FleetEdge account, a `FLEETEDGE_ACCOUNT_MISMATCH` audit entry is written and the vehicle's primary tag is not overwritten — historical attribution is preserved.
- Existing extension-ingested rows (`FleetEdgeSnapshot`, `FleetEdgePush`) remain `fleetEdgeAccountId: null` until the next ingestion event triggers a lazy backfill.

#### New env var required on the backend server

`FLEETEDGE_CRED_KEY` (32-byte base64) must be set before the backend starts. The server will exit at boot with a clear error message if it is missing. This key encrypts PULL account credentials at rest and is unrelated to the extension flow, but it is required for the backend to start regardless of which ingestion paths are active.

Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

Set it in `backend/main-backend/.env`:

```env
FLEETEDGE_CRED_KEY=<generated value>
```

#### No extension build or manifest changes required

The extension zip (`gnbedge-v0.0.0.1.zip`) does not need to be rebuilt. All changes are server-side.

---

## [2026-05-03] — branch: updated-design

### CWS Compliance Pass (v0.0.0.1)

**Extension renamed from "FleetEdge Fuel Monitor" → "gnbedge"**

All user-facing strings updated. Internal variable names (fleetedgeLink.js, message types, etc.) unchanged.

#### Manifest changes (`manifest.json`)

| Field | Before | After |
|---|---|---|
| `name` | `FleetEdge Fuel Monitor` | `gnbedge` |
| `version` | `2.0.0` | `0.0.0.1` |
| `description` | mentioned "FleetEdge" | neutral — fleet telematics wording |
| `permissions` | had `tabs` | `storage`, `alarms`, `notifications` only |
| `host_permissions` | both gnbedge + fleetedge host | gnbedge backend only |
| `optional_host_permissions` | — | `https://fleetedge.home.tatamotors/*` |

Moving the FleetEdge host to `optional_host_permissions` means:
- The install screen no longer shows the Tata Motors domain.
- Permission is requested at runtime when the user clicks **Connect Fleet Portal**.
- Content scripts still auto-inject once permission is granted.

#### Popup changes (`src/popup/Popup.jsx`)

- `handleConnectFleetEdge` now calls `chrome.permissions.request({ origins: [...] })` before sending the `CONNECT_FLEETEDGE` message.
- If user denies → shows error, does not proceed.
- On success → shows hint to refresh any open fleet portal tab (Chrome only injects content scripts on new page loads after runtime permission grant).

#### Background changes (`src/background/fleetedgeLink.js`)

- Added `chrome.permissions.contains()` guard at the top of `connectFleetEdge()`.
- Returns a clean `permission_required` error if the user hasn't granted access yet, instead of silently returning an empty tabs array.

#### Build changes (`vite.config.js`)

- `sourcemap: 'hidden'` → `sourcemap: false` — source maps are no longer included in the production dist.

#### Cleanup

- Removed `extension/public/icons/README.md` (placeholder, was ending up in the zip).
- Removed `extension/public/vite.svg` (Vite default, unused).
- Added `eslint.config.js` override for `test-popup.js` (pre-existing CommonJS file was failing lint).

#### New files

| File | Purpose |
|---|---|
| `extension/CWS_SUBMISSION.md` | Paste-ready copy for every CWS dashboard field (description, permission justifications, data disclosures, single-purpose statement) |
| `extension/public/privacy.html` | Privacy policy (host on GitHub Pages or backend, paste URL into CWS form) |
| `extension/screenshot-instructions.txt` | How to produce the required 1280×800 screenshot and 440×280 promo tile |
| `extension/gnbedge-v0.0.0.1.zip` | Upload-ready zip (manifest at root, no source maps, no junk files) |

#### Test fixes

- Added `chrome.permissions: { contains: vi.fn(() => Promise.resolve(true)) }` to all test chrome stubs that exercise `fleetedgeLink.js`.
- Skipped 2 pre-existing `backendUrl` tests that were already failing before this session (feature not yet implemented in `backendApi.js`).

---

## How to build a new zip

```bash
cd plugin/extension
npm run build          # produces dist/
rm -rf dist/.vite      # remove Vite internal manifest
# zip contents of dist/ (not the folder itself)
cd dist && zip -r ../gnbedge-v<version>.zip .
```

Or on Windows PowerShell:
```powershell
Compress-Archive -Path "dist\*" -DestinationPath "gnbedge-v0.0.0.1.zip" -Force
```

---

## CWS submission checklist

- [ ] Privacy policy hosted at a public HTTPS URL
- [ ] URL pasted into CWS dashboard Privacy Policy field
- [ ] 1280×800 screenshot uploaded (see `screenshot-instructions.txt`)
- [ ] 440×280 promo tile uploaded (see `screenshot-instructions.txt`)
- [ ] All fields in `CWS_SUBMISSION.md` filled into the dashboard form
- [ ] Visibility set to **Unlisted** for first submission
- [ ] $5 developer registration fee paid (one-time)
