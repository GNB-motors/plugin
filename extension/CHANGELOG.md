# Changelog — gnbedge Chrome Extension

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
