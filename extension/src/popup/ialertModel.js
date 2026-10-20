/**
 * iALERT Popup Model — Pure helpers
 * Maps backend iALERT account data to UI-friendly formats.
 */

/**
 * Map backend status to UI chip variant.
 * ACTIVE → ok (green)
 * NEEDS_REAUTH → warn (amber)
 * REVOKED / DISABLED → muted (grey)
 * Unknown → muted (grey)
 */
export function mapStatusToChip(status) {
  if (!status) return 'muted';
  switch (status) {
    case 'ACTIVE':
      return 'ok';
    case 'NEEDS_REAUTH':
      return 'warn';
    case 'REVOKED':
    case 'DISABLED':
      return 'muted';
    default:
      return 'muted';
  }
}

/**
 * Get human-readable label for chip variant.
 */
export function getChipLabel(status) {
  if (!status) return 'Unknown';
  switch (status) {
    case 'ACTIVE':
      return 'Active';
    case 'NEEDS_REAUTH':
      return 'Reconnect needed';
    case 'REVOKED':
      return 'Revoked';
    case 'DISABLED':
      return 'Disabled';
    default:
      return status;
  }
}

/**
 * Format expiresAt timestamp to local time string (HH:MM).
 * Returns '—' for null/undefined.
 */
export function formatExpiresAt(expiresAt) {
  if (!expiresAt) return '—';
  try {
    return new Date(expiresAt).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '—';
  }
}

/**
 * Get display label for an account row.
 * Uses friendlyName if present, otherwise externalAccountId.
 */
export function getAccountLabel(account) {
  if (!account) return 'Unknown';
  return account.friendlyName || account.externalAccountId || 'Unknown';
}

/**
 * Turn a failed status call into one sentence the user can act on.
 * @param {number|null|undefined} status HTTP status from the GNB backend, if any
 * @param {string|undefined} message the raw error message
 */
export function describeIalertProblem(status, message) {
  const m = String(message || '');
  if (status === 404) {
    return "Your GNB server doesn't support iALERT yet. Ask GNB support to enable the iALERT update.";
  }
  if (status === 401 || /not authenticated|log in first/i.test(m)) {
    return 'Sign in to GNB in this extension first, then try again.';
  }
  if (status === 403) {
    return 'Your GNB role cannot manage iALERT. Ask an owner or manager.';
  }
  if (status === 429) return 'Too many requests right now. Wait a minute, then press Retry.';
  if (status >= 500) return 'The GNB server had a problem. Press Retry in a minute.';
  // backendFetch rewrites failures to 'Request timed out after …' and
  // 'Backend unreachable (…)' — never show those raw (they carry the URL).
  if (/failed to fetch|network|timeout|timed out|unreachable|abort/i.test(m)) {
    return "Can't reach the GNB server. Check your internet, then press Retry.";
  }
  return m || 'Something went wrong. Press Retry.';
}
