/**
 * The words GNB Edge shows on a fleet portal tab while it links an account.
 * Shared by the content scripts (automatic link on sign-in) and the service
 * worker (the popup's Connect button), so both paths say exactly the same.
 *
 * Every function returns a showGnbBanner() options object. No tokens here.
 */

const TOO_OLD = 'IALERT_TOKEN_TOO_OLD';

export function ialertWaitingBanner() {
  return {
    tone: 'progress',
    title: 'Sign in to iALERT',
    body: 'GNB Edge connects automatically as soon as you sign in.',
  };
}

export function ialertConnectingBanner() {
  return { tone: 'progress', title: 'Connecting iALERT to GNB Edge…' };
}

/**
 * @param {{ refreshStored?: boolean }} result linkIalertSession() success result
 */
export function ialertLinkedBanner(result) {
  if (result?.refreshStored) {
    return {
      tone: 'ok',
      title: 'iALERT is connected to GNB Edge',
      body: 'Your vehicles appear in GNB within a few minutes. You can close this tab; the connection keeps working.',
      autoHideMs: 15000,
    };
  }
  // Without a stored refresh token the backend cannot renew the session on its
  // own: the open iALERT tab renews it and GNB Edge forwards each renewal.
  return {
    tone: 'ok',
    title: 'iALERT is connected to GNB Edge',
    body: 'Your vehicles appear in GNB within a few minutes. Keep this iALERT tab open: while it is open, GNB Edge keeps the connection renewed.',
    autoHideMs: 20000,
  };
}

/**
 * @param {{ code?: string, error?: string }} result linkIalertSession() failure result
 */
export function ialertFailureBanner(result) {
  const error = String(result?.error || '');
  if (result?.code === TOO_OLD) {
    return {
      tone: 'warn',
      title: 'Sign in to iALERT again',
      body: 'This sign-in is too old to connect. Sign out of iALERT and sign in again; GNB Edge connects automatically.',
    };
  }
  if (/not authenticated|log in first/i.test(error)) {
    return {
      tone: 'warn',
      title: 'Almost there: sign in to GNB Edge',
      body: 'Open the GNB Edge extension, sign in, then press Connect iALERT within 10 minutes.',
    };
  }
  return {
    tone: 'err',
    title: 'Could not connect iALERT',
    body: error || 'Something went wrong. Press Connect iALERT in GNB Edge to try again.',
  };
}

export const FLEETEDGE_CLOSE_AFTER_MS = 5000;

/** @param {number|null|undefined} vehicleCount */
export function fleetEdgeLinkedBanner(vehicleCount) {
  const n = Number(vehicleCount) || 0;
  const vehicles =
    n > 0
      ? `${n.toLocaleString('en-IN')} ${n === 1 ? 'vehicle is' : 'vehicles are'} syncing. `
      : '';
  return {
    tone: 'ok',
    title: 'FleetEdge is connected to GNB Edge',
    body: `${vehicles}This tab closes by itself and signs FleetEdge out here, so GNB keeps the connection. You can sign in again any time.`,
    closeAfterMs: FLEETEDGE_CLOSE_AFTER_MS,
  };
}

export function fleetEdgeNoRenewBanner() {
  return {
    tone: 'warn',
    title: "Connected, but it can't renew itself",
    body: 'Sign out of FleetEdge, sign in again, wait for the map to load, then press Connect in GNB Edge.',
  };
}
