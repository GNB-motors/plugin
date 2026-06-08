/**
 * Popup lifecycle helpers — extracted from Popup.jsx so they can be unit tested
 * in the existing node-environment Vitest setup (which does not load React/DOM).
 */

/**
 * Resets all transient popup state that belongs to a single user session.
 * Called on logout and clearData so the next signed-in user never sees the
 * previous user's accounts/logs/dismissed banners/modals/toasts.
 *
 * Operates entirely via the passed-in React setters — pure, easy to mock.
 *
 * @param {object} setters
 */
export function resetTransientState(setters) {
  const {
    setAppState,
    setView,
    setLogs,
    setToast,
    setConfirming,
    setDismissedBanners,
    setLoginLoading,
    setLoginError,
  } = setters;
  // Use a logged-out object rather than null — null re-enters the bootstrap
  // loading screen because Popup.jsx treats appState === null as "not yet
  // initialised". A non-null logged-out state takes us straight to login.
  setAppState?.({ authenticated: false });
  setView?.('login');
  setLogs?.([]);
  setToast?.(null);
  setConfirming?.(null);
  setDismissedBanners?.(new Set());
  setLoginLoading?.(false);
  setLoginError?.('');
}

/**
 * Wraps an async producer so its result is only delivered to `apply` when the
 * caller is still alive. Used as the test-friendly core of the
 * AbortController + cancelled-flag pattern around `chrome.runtime.sendMessage`.
 *
 * @template T
 * @param {() => Promise<T>} producer  async work (e.g. sendMessage)
 * @param {(value: T) => void} apply   called only if not cancelled / aborted
 * @param {{ isCancelled?: () => boolean, signal?: AbortSignal }} guard
 * @returns {Promise<void>}
 */
export async function runIfMounted(producer, apply, guard = {}) {
  const result = await producer();
  if (guard.signal?.aborted) return;
  if (guard.isCancelled && guard.isCancelled()) return;
  apply(result);
}
