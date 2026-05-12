# Extension Background Service — v2.0.0

Core background logic for the GNB Chrome extension (Manifest V3). Handles authentication, FleetEdge token linking, status polling, and LEMU telemetry.

> **v2.0.0 — Backend Direct Architecture:** All FleetEdge API calls are made server-side by `FleetEdgeProxyService`. The extension is a thin status display + token provider. No `webRequest`, `scripting`, or `tabs` permissions.

## Architecture

```
┌─── manifest.json (declares service worker + content script)
│
├─── index.js (service worker entry point)
│     ├─ Message routing (onMessage)
│     ├─ chrome.alarms for status polling (2 min)
│     ├─ Auth lifecycle (LOGIN, LOGOUT, GET_AUTH_STATUS)
│     ├─ FleetEdge link (CONNECT, DISCONNECT, STATUS)
│     ├─ Task trigger (TRIGGER_PROCESS)
│     └─ LEMU telemetry handlers
│
├─── fleetedgeLink.js (FleetEdge connection flow)
│     ├─ connectFleetEdge() → find tab → message content script → link to backend
│     ├─ getFleetEdgeStatus() → GET /fleetedge/status
│     └─ disconnectFleetEdge() → POST /fleetedge/unlink
│
├─── backendApi.js (Authenticated HTTP client)
│     ├─ login() → POST /auth/login → store token
│     ├─ logout() → clear auth state
│     ├─ backendFetch(path) → authenticated fetch with timeout
│     ├─ fetchVehiclesFromBackend() → GET /vehicles
│     └─ fetchStatus() → GET /status
│
├─── config.js (Configuration constants)
│     ├─ BACKEND_BASE_URL, API_PREFIX
│     ├─ STATUS_POLL_INTERVAL_MINUTES: 2
│     └─ TELEMETRY_* settings
│
├─── telemetry.js (LEMU — 7-layer telemetry system)
│     ├─ record() → log events with layer + severity
│     ├─ 7 layers: UI, MESSAGE, BACKEND, FLEETEDGE, STORAGE, TOKEN, TASK
│     ├─ Ship WARN+ to backend (batched 60s)
│     └─ Health snapshots every 5 min
│
├─── logger.js (Simple logging)
│     ├─ createLogger(module) → namespaced logger
│     ├─ getLogs(limit) → recent log entries
│     └─ clearLogs() → reset
│
└─── utils.js (Utilities)
      ├─ getStorage() / setStorage() / removeStorage()
      ├─ decodeJwtPayload() → JWT parsing
      ├─ normalizeRegistration() → strip special chars
      ├─ checkTokenExpiry() → check JWT exp claim
      └─ formatISTDateTime() → UTC → IST conversion

Content Script (declared in manifest, runs on FleetEdge):
└─── src/content/fleetedgeTokenReader.js
      ├─ Listens for READ_FLEETEDGE_TOKEN message
      ├─ Scans localStorage + sessionStorage for Keycloak JWTs
      └─ Returns { token, fleetId, exp, foundIn }
```

## Data Flow: FleetEdge Token Link

```
[User logs into FleetEdge in browser]
         ↓
[User clicks "Connect FleetEdge" in popup]
         ↓
[index.js → CONNECT_FLEETEDGE handler]
         ↓
[fleetedgeLink.js: connectFleetEdge()]
         ↓ (find FleetEdge tab)
[chrome.tabs.query({ url: fleetedge.home.tatamotors/* })]
         ↓ (message content script)
[fleetedgeTokenReader.js: scan localStorage for JWT]
         ↓ (token + fleetId returned)
[backendFetch: POST /fleetedge/link-token]
         ↓ (backend validates against CVP API)
[Token stored on backend → cron processing starts]
```

## Data Flow: Task Processing (Backend-Side)

```
[FleetEdgeCronService: every 5 minutes]
         ↓
[Find orgs with linked FleetEdge tokens]
         ↓
[FleetEdgeProxyService.processPendingTasksBatch(orgId)]
         ↓
[Fetch VIN map from FleetEdge CVP API]
         ↓
[For each pending task: call /analyse-fuel-consumption]
         ↓
[FuelComparisonService: process results, flag discrepancies]
         ↓
[Tasks marked completed/failed in MongoDB]
```

## File Responsibilities

### index.js
- **Service worker entry point** — registered by manifest.json
- **Message routing** — `chrome.runtime.onMessage` dispatcher
- **Status polling** — `chrome.alarms` every 2 minutes checks FleetEdge status
- **Handlers:** LOGIN, LOGOUT, GET_AUTH_STATUS, GET_STATUS, CONNECT_FLEETEDGE, DISCONNECT_FLEETEDGE, GET_FLEETEDGE_STATUS, TRIGGER_PROCESS, SET_BACKEND_URL, GET_LOGS, CLEAR_LOGS, CLEAR_ALL, plus LEMU telemetry handlers

### fleetedgeLink.js
- **Token link flow** — orchestrates content script → backend token delivery
- **Tab discovery** — finds open FleetEdge tabs via `chrome.tabs.query()`
- **Status checking** — `getFleetEdgeStatus()` polls backend
- **Disconnect** — `disconnectFleetEdge()` unlinks token from backend

### backendApi.js
- **Authenticated HTTP client** — all requests include `Authorization: Bearer <token>`
- **Timeout protection** — 15-second `AbortController` timeout
- **401 handling** — auto-clears auth state on expired tokens
- **Exported:** `login`, `logout`, `isAuthenticated`, `backendFetch`, `fetchVehiclesFromBackend`, `fetchStatus`

### config.js
- **Backend URL** — `BACKEND_BASE_URL` (default: `http://localhost:3000`)
- **Polling** — `STATUS_POLL_INTERVAL_MINUTES: 2`
- **Telemetry** — all `TELEMETRY_*` settings for LEMU

### telemetry.js
- **LEMU core** — event recording, buffering, shipping
- **7 layers** — UI, MESSAGE, BACKEND, FLEETEDGE, STORAGE, TOKEN, TASK
- **Breadcrumbs** — last 50 actions attached to ERROR/FATAL events
- **User environment** — browser, OS, RAM, CPU, screen, network
- See [LEMU Developer Guide](../../../../lemu/docs/LEMU.md) for full details

### utils.js
- **Storage wrappers** — `getStorage()`, `setStorage()`, `removeStorage()`
- **JWT parsing** — `decodeJwtPayload()` without dependencies
- **Registration normalization** — strips `/[^a-zA-Z0-9]/g`
- **IST formatting** — `formatISTDateTime()` for UTC → IST display

### content/fleetedgeTokenReader.js
- **Declared content script** — auto-injected on `fleetedge.home.tatamotors/*`
- **Token scanning** — checks known Keycloak keys, then scans all localStorage/sessionStorage
- **JWT validation** — only returns tokens with `fleet_id` in payload
- **Message-driven** — responds to `READ_FLEETEDGE_TOKEN` from service worker

## Key Patterns

### Content Script Communication
```javascript
// Service worker → content script:
const [tab] = await chrome.tabs.query({ url: 'https://fleetedge.home.tatamotors/*' });
const response = await chrome.tabs.sendMessage(tab.id, { type: 'READ_FLEETEDGE_TOKEN' });
// response: { success: true, token: 'eyJ...', fleetId: 'U1738...', exp: 1773279972 }
```

### Backend Proxy Fetch
```javascript
// Authenticated request to backend FleetEdge proxy:
import { backendFetch } from './backendApi.js';
const response = await backendFetch('/fleetedge/status');
const data = await response.json();
// data: { data: { status: 'linked', tokenExp: 1773279972, fleetId: '...' } }
```

### Status Polling via Alarms
```javascript
// Set up periodic polling (service worker friendly):
chrome.alarms.create('fleetedge-status-poll', { periodInMinutes: 2 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'fleetedge-status-poll') {
    const status = await getFleetEdgeStatus();
    await setStorage({ fleetEdgeStatus: status });
  }
});
```

## Testing

153 tests across 7 files — run with:

```bash
npx vitest run
```

| File | Tests | Coverage |
|------|------:|----------|
| `utils.test.js` | 16 | Storage wrappers, JWT decode, registration normalization |
| `logger.test.js` | 6 | Logger creation, log retrieval, clear |
| `backendApi.test.js` | 20 | Login, logout, backendFetch, timeout, 401 handling |
| `telemetry.test.js` | 45 | LEMU telemetry: record, ship, breadcrumbs, health |
| `integration.test.js` | 10 | Auth → status flow, FleetEdge link endpoints, metrics |
| `edge-cases-integration.test.js` | 10 | Timeout, 401 clear, FleetEdge link edge cases |
| `edge-cases-utils.test.js` | 46 | Null inputs, boundary conditions, malformed data |

## Dependencies
- **chrome API** — storage, runtime, action, alarms, notifications, tabs (for messaging only)
- **fetch API** — HTTP requests (no axios)
- **No sensitive permissions** — no webRequest, scripting, or host access to FleetEdge

## Related Documentation
- [Extension README](../../README.md) — Full extension guide + backend integration
- [LEMU Developer Guide](../../../../lemu/docs/LEMU.md) — Telemetry system architecture
- [Backend Extension Docs](../../../../backend/main-backend/docs/EXTENSION_API_README.md) — Backend endpoint spec
