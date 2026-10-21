/**
 * iALERT popup view-model — pure helpers over GET /extension/ialert/status rows:
 *   { accountId, externalAccountId, friendlyName, accountStatus, status,
 *     canSelfRenew, vehicleCount, lastDataAt, plan, lastErrorMessage, … }
 */

/**
 * One badge per iALERT row — the same rules as the web app's Settings page
 * (main-frontend ialertAccountsModel.connectionBadge). The account's admin
 * state wins over the session state. iALERT sessions carry no expiry time,
 * so none is shown.
 * @returns {{ label: string, tone: 'ok' | 'warn' | 'crit' | 'muted' }}
 */
export function ialertBadge(row) {
  if (row?.accountStatus === 'DISABLED') return { label: 'Disabled by admin', tone: 'muted' };
  if (row?.accountStatus === 'AUTH_FAILED') return { label: 'Reconnect needed', tone: 'crit' };
  if (row?.status === 'NEEDS_REAUTH') {
    return row.canSelfRenew
      ? { label: 'Renewing', tone: 'warn' }
      : { label: 'Reconnect needed', tone: 'crit' };
  }
  if (row?.status === 'ACTIVE') return { label: 'Connected', tone: 'ok' };
  return { label: 'Unknown', tone: 'muted' };
}

/** The account's name as a person would say it. */
export function ialertAccountName(row) {
  if (row?.friendlyName) return row.friendlyName;
  if (row?.externalAccountId) return `iALERT account ${row.externalAccountId}`;
  return 'iALERT account';
}

/**
 * The most urgent subscription note, or null. `plan.expired/next15/next30`
 * are vehicle COUNTS per bucket.
 * @returns {{ text: string, tone: 'warn' | 'crit' } | null}
 */
export function ialertPlanNote(plan) {
  if (!plan) return null;
  const n = (k) => (Number.isFinite(plan[k]) ? plan[k] : 0);
  const veh = (c) => `${c} ${c === 1 ? 'vehicle' : 'vehicles'}`;
  if (n('expired') > 0) {
    return { text: `Plan expired for ${veh(n('expired'))}`, tone: 'crit' };
  }
  if (n('next15') > 0) {
    return { text: `Plan ends within 15 days for ${veh(n('next15'))}`, tone: 'warn' };
  }
  if (n('next30') > 0) {
    return { text: `Plan ends within 30 days for ${veh(n('next30'))}`, tone: 'warn' };
  }
  return null;
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

/**
 * One sentence for the result of the popup's Connect iALERT (background connectIalert()).
 * @param {{ success?: boolean, state?: string, tab?: string, error?: string,
 *           refreshStored?: boolean } | null | undefined} res
 * @returns {{ text: string, kind: 'ok'|'err'|'' }}
 */
export function describeConnectResult(res) {
  switch (res?.state) {
    case 'LINKED':
      return res.refreshStored
        ? { text: 'iALERT connected ✓ You can close the iALERT tab.', kind: 'ok' }
        : { text: 'iALERT connected ✓ Keep the iALERT tab open to stay connected.', kind: 'ok' };
    case 'WAITING':
      return res.tab === 'focused'
        ? { text: 'Sign in on your iALERT tab. GNB Edge connects as soon as you do.', kind: '' }
        : { text: 'iALERT is open. Sign in there and GNB Edge connects by itself.', kind: '' };
    case 'SIGN_IN_AGAIN':
      return {
        text: 'That iALERT sign-in is too old. Sign out of iALERT and sign in again; it connects by itself.',
        kind: 'err',
      };
    default:
      return {
        text: describeIalertProblem(null, res?.error) || 'Could not connect iALERT',
        kind: 'err',
      };
  }
}
