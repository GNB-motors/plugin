# Extension Background Service

Core background logic for the GNB Chrome extension (Manifest V3). Handles authentication, task polling, result submission, error reporting, and data synchronization.

## Architecture

```
┌─── manifest.json (declares service worker)
│
├─── background.js (entry point)
│     ├─ Message routing (onMessage)
│     ├─ Tab injection permissions
│     └─ Extension lifecycle
│
├─── auth.js (Session management)
│     ├─ loginExtension() → backend /login
│     ├─ checkTokenExpiry() → validate or refresh
│     └─ getStoredToken() → chrome.storage.local
│
├─── taskPoller.js (Polling loop)
│     ├─ poll() → backend /tasks (every 5s if in vehicle)
│     ├─ updateUI() → send badge count to content script
│     └─ retry backoff (exponential)
│
├─── taskSubmitter.js (Submission logic)
│     ├─ submitTaskResult() → backend /submit-result
│     ├─ computeFuelConsumption() → from tab telemetry
│     └─ retry logic + local queue fallback
│
├─── errorReporter.js (Error tracking)
│     ├─ reportError() → backend /submit-error
│     ├─ batch errors (10s debounce)
│     └─ unrecoverable error detection
│
├─── utils.js (Utilities)
│     ├─ normalizeRegistration() → alphanumeric only
│     ├─ retryWithBackoff() → exponential retry helper
│     ├─ isTokenExpired() → check JWT exp claim
│     ├─ safeJsonParse() → JSON with fallback
│     └─ formatISTDateTime() → IST timezone conversion
│
└─── backendApi.js (HTTP client)
      ├─ submitFuelData(taskId, results) → POST /submit-result
      ├─ reportError(taskId, errorMsg) → POST /submit-error
      └─ sendHeartbeat(metrics) → POST /heartbeat
```

## Data Flow: Task Lifecycle

```
[Backend Task Queue]
         ↓ (poll /tasks every 5s)
[taskPoller.js: getPendingTasks()]
         ↓
[UI: Badge count updated]
         ↓
[User opens extension popup]
         ↓
[content.js injects fuel sensor]
         ↓
[Fuel data collected in tab]
         ↓ (messagePort to background.js)
[taskSubmitter.js: processResult()]
         ↓
[backendApi.js: submitFuelData()]
         ↓
[Backend Task marked complete]
```

## File Responsibilities

### background.js
- **Manifest entry point** — service worker registration
- **Message routing** — `onMessage` dispatcher to auth/taskPoller/errorReporter
- **Tab injection** — requests `activeTab` permission for content script
- **Lifecycle** — handles extension install/update/uninstall

### auth.js
- **Login flow** — launches OAuth2 prompt if needed
- **Token validation** — `checkTokenExpiry()` with 60-second buffer
- **Storage** — reads/writes to `chrome.storage.local`
- **Error** — throws if login fails

### taskPoller.js
- **Polling loop** — 5-second interval when in vehicle
- **Backoff** — exponential retry on network error
- **UI updates** — sends badge count via message
- **State** — tracks last poll time to avoid storms

### taskSubmitter.js
- **Result processing** — validates fuel data structure
- **Submission** — calls `backendApi.submitFuelData()`
- **Retry** — local queue if offline, sync on reconnect
- **Error handling** — catches network + validation errors

### errorReporter.js
- **Error batching** — accumulates errors, flushes every 10s
- **Severity** — classifies as ERROR or CRITICAL
- **Debounce** — prevents spam on simultaneous failures
- **Unrecoverable** — marks extension as broken if auth fails

### utils.js
- **normalizeRegistration()** — strips special chars: `/[^a-zA-Z0-9]/g`
- **retryWithBackoff()** — exponential backoff with jitter
- **isTokenExpired()** — checks JWT `exp` claim with buffer
- **safeJsonParse()** — JSON.parse with fallback value
- **formatISTDateTime()** — UTC → IST (UTC+5:30) conversion

### backendApi.js
- **HTTP requests** — fetch() with JWT in Authorization header
- **submitFuelData()** — POST with results array
- **reportError()** — POST with error details
- **sendHeartbeat()** — POST with uptime metrics
- **Error responses** — throws on non-2xx status

## Key Patterns

### Token Refresh Logic
```javascript
// Before any API call:
if (isTokenExpired(token, 60)) {  // 60-second buffer
  token = await refreshToken();
}
// Then make request with Authorization: Bearer ${token}
```

### Retry with Exponential Backoff
```javascript
await retryWithBackoff(
  async () => submitFuelData(taskId, results),
  3,           // max attempts
  1000         // 1 second base delay
);
// Delays: 1s, 2s, 4s (exponential)
```

### IST Time Conversion
```javascript
// All timestamps FROM extension → UTC
// Backend converts to IST for display
// formatISTDateTime() handles IST display: UTC + 5:30 hours
```

### Registration Normalization
```javascript
// Input: "DL1AC1234*"
// normalizeRegistration() → "DL1AC1234"
// Used for DB lookup, matches backend normalization
```

## Testing

See [TESTING.md](./TESTING.md) for:
- Unit tests (utils, auth, retry logic)
- Integration tests (full task lifecycle)
- Mock setup (vi.mock for chrome API)

Test files:
- `auth.test.js` — login, token refresh, expiry
- `taskPoller.test.js` — polling intervals, backoff
- `taskSubmitter.test.js` — result validation, retry
- `errorReporter.test.js` — batching, debounce
- `utils.test.js` — 46 edge cases for utilities
- `integration/` — full flow tests

## Sync Notes

**UI state sync between background and popup:**
```javascript
// background.js: Update badge
chrome.action.setBadgeText({ text: count.toString() });

// popup.js: Request latest state
const response = await chrome.runtime.sendMessage({
  action: 'getTaskCount'
});
```

**Local vs Cloud Sync:**
- Token stored in `chrome.storage.local`
- Failed submissions queued locally, retried on reconnect
- Heartbeat sent every 30s (tells backend extension is alive)

## Troubleshooting

| Issue | Cause | Check |
|-------|-------|-------|
| Badge not updating | taskPoller not running | Check `isInVehicle` flag in message handler |
| "401 Unauthorized" | Token expired | `checkTokenExpiry()` buffer may be too small |
| "Network error" on submit | Extension offline | backendApi catches, queues locally |
| Task stuck "pending" | Backend timeout | Check backend logs; extension heartbeat may have failed |

## Dependencies
- **chrome API** — storage, runtime, action, tabs (MV3)
- **fetch API** — HTTP requests (no axios/jquery)
- **crypto** — JWT parsing (simple split on '.')
- **utils.js** — Shared retry/time helpers

## Related Documentation
- [../TESTING.md](../TESTING.md) — Full test suite guide
- [../../backend/docs/EXTENSION_API_README.md](../../backend/docs/EXTENSION_API_README.md) — Backend endpoint spec
- [../../backend/docs/EXTENSION_BACKEND_FILES.md](../../backend/docs/EXTENSION_BACKEND_FILES.md) — Which backend files serve extension
