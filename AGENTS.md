# AGENTS.md — gnbedge plugin

Guide for human and AI contributors working in this repo.

## Repository layout

```
plugin/
├── extension/              # The actual Chrome extension (Manifest V3)
│   ├── src/
│   │   ├── background/     # Service worker (token link flow, backend API client, telemetry)
│   │   │   └── __tests__/  # Vitest unit + integration tests (mocked chrome + fetch)
│   │   ├── content/        # Declared content scripts (networkSpy + tokenReader)
│   │   └── popup/          # React popup UI
│   ├── public/icons/       # Extension icons (16, 48, 128 px)
│   ├── scripts/            # Build helpers + CWS policy & security checks
│   │   ├── check-manifest-policy.cjs
│   │   ├── check-secrets.cjs
│   │   ├── build-zip.cjs
│   │   └── upload-sourcemaps.cjs
│   ├── e2e/                # Playwright smoke tests
│   │   └── smoke.spec.js
│   ├── playwright.config.js
│   ├── manifest.json       # Source of truth for CWS submission
│   ├── README.md           # End-user / dev-onboarding documentation
│   ├── CHANGELOG.md        # Per-session change log (date-stamped, branch-stamped)
│   ├── CWS_SUBMISSION.md   # Paste-ready content for the CWS Developer Dashboard
│   ├── TESTING.md          # Testing guide + manual QA checklist
│   └── package.json        # All npm scripts live here, NOT at repo root
├── .github/
│   ├── workflows/          # CI (validate, smoke, codeql, dependency-review)
│   ├── pull_request_template.md
│   └── ISSUE_TEMPLATE/     # bug_report.yml + feature_request.yml
├── AGENTS.md               # This file
└── CLAUDE.md               # 1-line include of AGENTS.md
```

**All package.json scripts run from `extension/`, never the repo root.** CI workflows set `working-directory: extension`.

## Active branches

- `Devayan` — currently the latest. Contains everything in `updated-design` plus the multi-account popup redesign, CI hardening, and security audits. Releases are cut from here.
- `updated-design` — older, contains the CWS-compliance pass and the auto-refresh retry. Kept for history; new work should branch from `Devayan`.
- `main` — **protected production branch**. Has branch protection (1 approval + 4 required status checks). Workflow files and docs are seeded here so status checks work. Do not push directly.

When the user says "push", confirm the target branch before pushing — branch policies vary per repo.

## Build / test / lint

All from `extension/`:

```bash
npm install          # First time, or after dependency changes
npm run lint         # ESLint over src/
npm test             # Vitest, 187 tests, ~20 sec (1 test deliberately waits 3 s for setTimeout)
npm run build        # Vite production build → dist/
npm run build:zip    # Build + zip for CWS submission
```

CI runs all four on every PR; status check name: `validate`.

### Security & CWS-policy checks

- `npm run check:manifest` — Banned permissions, host rules, CSP, icon existence (`scripts/check-manifest-policy.cjs`)
- `npm run check:secrets` — Hardcoded API keys, eval, document.write, remote imports (`scripts/check-secrets.cjs`)
- `npm run check:security` — All three above + `npm audit --audit-level=high`
- `npm run test:smoke` — Playwright loads `dist/` into headed Chromium, opens popup, asserts no console errors

CI runs all of these on every PR via four workflows:
- `validate.yml` — lint + unit tests + build + check:security
- `codeql.yml` — GitHub native static analysis (XSS, injection)
- `dependency-review.yml` — blocks PRs adding high-severity vulnerable deps
- `smoke.yml` — Playwright smoke test

## CWS (Chrome Web Store) constraints

The extension is published at `chrome-extension://<id>` as **gnbedge**. Currently **Unlisted**; the Tata-Motors host permission means moving to Public risks trademark rejection (see `extension/CWS_SUBMISSION.md`).

**Rules that must not be broken without explicit user approval:**

1. **No `webRequest`, `scripting`, or `tabs` permissions.** The whole architecture was redesigned in v2.0.0 to avoid these (see README "Migration from v1.x"). Adding them back means re-justifying to CWS and possibly being rejected.
2. **`https://fleetedge.home.tatamotors/*` stays in `optional_host_permissions`, not `host_permissions`.** Granted at runtime, not install — this is what keeps the install screen clean.
3. **No remote code execution.** All JS is bundled at build time. No CDN imports, no `eval`, no remote-loaded scripts.
4. **`manifest.json` version must monotonically increase.** CWS rejects re-uploads of the same version. Bump before every `build:zip`.

## Test conventions

- **Mocked chrome API.** Every test that touches `chrome.*` builds its own `chromeMock` and calls `vi.stubGlobal('chrome', chromeMock)`. When you add a new `chrome.tabs.X` call in production code, you usually need to add it to the mocks in `edge-cases-v2.test.js` (shared `makeStore`) and `edge-cases-integration.test.js` (each test's local mock).
- **Mocked fetch.** Use `global.fetch = vi.fn(() => Promise.resolve(new Response(...)))`.
- **Telemetry capture.** Tests can replace the telemetry module via `vi.doMock('../telemetry.js', ...)` and push every emitted event into a local array for assertions.
- **The 3-second test.** `connectFleetEdge handles sendMessage error gracefully` actually waits 3 seconds because the production code reloads the FleetEdge tab and waits for content-script injection. Do not fake-timer this away without also faking the production timeout — the test exists to verify the wait happens.

## Backend integration

The extension is a thin client; the backend (`GNB-motors/main-backend`, branch `Devayan`) does all FleetEdge API work.

Endpoints the extension calls (all under `/api/extension/`):

- `POST /auth/login`
- `POST /fleetedge/link-token` (request body must include `token` and `fleetId`)
- `GET /fleetedge/status`
- `POST /fleetedge/unlink/:accountId` (single account)
- `POST /fleetedge/unlink` (all user's accounts)
- `POST /fleetedge/process-tasks`

The backend `linkToken` flow now (May 2026):
1. Decodes the JWT to read `exp`.
2. Calls FleetEdge `/api/vehicle-service/get-vin-for-dashboard` to validate the token.
3. Calls FleetEdge `/api/user-service/get-user-document-master` to read the FleetEdge user's profile.
4. Stores the token as an **AES-256-GCM-encrypted** `UserFleetEdgeToken` row (key: `FLEETEDGE_CRED_KEY`), not on `User`.
5. Calls `resolveAndTag(orgId, 'EXTENSION', fleetId, null, friendlyName)` so the `FleetEdgeAccount` row has a human-readable name like `"Ajit Kumar Singh (email@domain.com)"` instead of the raw fleet ID.

If the backend is changed in a way that breaks these contracts (e.g. renaming a field in the response body), the extension popup will silently fail. Always grep the extension for the endpoint path before changing a backend response shape.

## Local development gotchas

- **Docker on Windows + nodemon = no auto-reload.** Backend changes require `docker compose restart app`. Filesystem events from the Windows host don't propagate into the container.
- **`VITE_API_BASE_URL` in the frontend `.env` defaults to localhost.** The production URL is `https://api.app.gnbedge.in/v1/` — switching back to localhost for dev is intentional, do not commit that change to a release branch.
- **Vite dev server doesn't run the extension.** `npm run dev` is only useful for popup UI iteration. The actual extension always loads from a Chrome `Load unpacked` pointed at `dist/` (after `npm run build`).
- **`crxjs` rebuilds the service worker on file change** when running `dev`, but Chrome caches the old worker — click the refresh icon on `chrome://extensions/` after every background change.

## Commit / PR conventions

- **No `Co-Authored-By:` trailers.** The user has corrected this multiple times; respect it.
- **One PR per logical change.** Don't bundle the auto-refresh fix with the multi-account UI redesign — they review independently.
- **`CHANGELOG.md` gets a new dated section per session.** Format: `## [YYYY-MM-DD] — branch: <branch>`. New entries go at the top.

## What NOT to do without asking

- Bump the manifest `version` field silently — it's tied to the CWS submission cycle.
- Add a new `chrome.*` permission to `manifest.json`.
- Change the `name` field — it's "gnbedge" for CWS reasons (the original name "FleetEdge Fuel Monitor" triggered trademark concerns).
- Push to `main`.
- Remove or rename files in `src/background/__tests__/` — the count `187 tests` is referenced in README and CHANGELOG.
- Run `docker compose down -v` — wipes the local Mongo and the user has live data in it.

## Where to look when something is broken

| Symptom | First place to look |
|---|---|
| "Connect FleetEdge" fails | `src/background/fleetedgeLink.js` + check FleetEdge tab is open |
| Tasks never process | Backend `FleetEdgeCronService.runForOrg` / `FleetEdgePullService` + check the org has at least one `ACTIVE` `UserFleetEdgeToken` row (encrypted, not on `User`) |
| Tests fail with "chrome.tabs.X is not a function" | Mock missing in `edge-cases-v2.test.js > makeStore` or per-test mock |
| Build fails | Delete `extension/node_modules` + `package-lock.json`, reinstall |
| CWS upload fails "manifest not at root" | Re-zip with `Compress-Archive -Path "dist\*"` (the `\*` is essential) |
| Popup shows stale data | Background service worker cached; refresh it on `chrome://extensions/` |
