export const config = {
  BACKEND_BASE_URL: import.meta.env.VITE_BACKEND_BASE_URL || 'https://your-backend.example.com/api',
  CVP_API_BASE: 'https://cvp.api.tatamotors',
  // Note: FleetEdge API calls are injected into the open tab via chrome.scripting.executeScript
  // so Chrome handles the Origin header automatically — no need to set it explicitly.

  POLL_INTERVAL_MINUTES: parseInt(import.meta.env.VITE_POLL_INTERVAL_MINUTES) || 5,
  INTER_TASK_DELAY_MS: parseInt(import.meta.env.VITE_INTER_TASK_DELAY_MS) || 500,
  VIN_CACHE_TTL_HOURS: parseInt(import.meta.env.VITE_VIN_CACHE_TTL_HOURS) || 24,
  TOKEN_EXPIRY_BUFFER_SECONDS: parseInt(import.meta.env.VITE_TOKEN_EXPIRY_BUFFER_SECONDS) || 60,
  SEARCH_WINDOW_MINUTES: parseInt(import.meta.env.VITE_SEARCH_WINDOW_MINUTES) || 30,
  
  LOG_RETENTION_COUNT: parseInt(import.meta.env.VITE_LOG_RETENTION_COUNT) || 500,
  MAX_RETRY_ATTEMPTS: parseInt(import.meta.env.VITE_MAX_RETRY_ATTEMPTS) || 2,
};
