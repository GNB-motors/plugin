export const config = {
  BACKEND_BASE_URL: import.meta.env.VITE_BACKEND_BASE_URL || 'https://your-backend.example.com',
  API_PREFIX: '/api/extension',

  // Status polling interval (backend does the actual FleetEdge work now)
  STATUS_POLL_INTERVAL_MINUTES: parseInt(import.meta.env.VITE_STATUS_POLL_INTERVAL_MINUTES) || 2,

  LOG_RETENTION_COUNT: parseInt(import.meta.env.VITE_LOG_RETENTION_COUNT) || 500,
  MAX_RETRY_ATTEMPTS: parseInt(import.meta.env.VITE_MAX_RETRY_ATTEMPTS) || 2,

  // ─── LEMU Telemetry ─────────────────────────────────────────────────────
  TELEMETRY_ENABLED: true,
  TELEMETRY_MIN_SEVERITY: 'DEBUG', // Minimum severity to capture locally
  TELEMETRY_MAX_EVENTS: 2000, // Max events in chrome.storage.local
  TELEMETRY_FLUSH_INTERVAL_MS: 5_000, // Flush buffer to storage every 5s
  TELEMETRY_SHIP_TO_BACKEND: true, // Ship WARN+ events to backend
  TELEMETRY_BACKEND_ENDPOINT: '/telemetry/ingest', // Relative to API_PREFIX
  TELEMETRY_SHIP_BATCH_SIZE: 25, // Max events per backend shipment
  TELEMETRY_SHIP_INTERVAL_MS: 60_000, // Ship to backend every 60s
  TELEMETRY_HEALTH_CHECK_INTERVAL_MS: 300_000, // Health snapshot every 5min
  FETCH_TIMEOUT_MS: 15_000, // Global fetch timeout
};
