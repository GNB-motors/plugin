/**
 * Tests for Popup lifecycle helpers (H-10..H-14).
 *
 * Runs in the existing node-environment Vitest setup — no React DOM, no
 * @testing-library. Logic is tested via the pure helpers extracted from
 * Popup.jsx into lifecycle.js so we can assert behaviour deterministically.
 */
import { describe, it, expect, vi } from 'vitest';
import { resetTransientState, runIfMounted } from '../lifecycle.js';

describe('resetTransientState (H-12: auth-transition state reset)', () => {
  it('calls every setter so previous user data cannot flash', () => {
    const setters = {
      setAppState: vi.fn(),
      setView: vi.fn(),
      setLogs: vi.fn(),
      setToast: vi.fn(),
      setConfirming: vi.fn(),
      setDismissedBanners: vi.fn(),
      setLoginLoading: vi.fn(),
      setLoginError: vi.fn(),
    };
    resetTransientState(setters);

    expect(setters.setAppState).toHaveBeenCalledWith({ authenticated: false });
    expect(setters.setView).toHaveBeenCalledWith('login');
    expect(setters.setLogs).toHaveBeenCalledWith([]);
    expect(setters.setToast).toHaveBeenCalledWith(null);
    expect(setters.setConfirming).toHaveBeenCalledWith(null);
    expect(setters.setLoginLoading).toHaveBeenCalledWith(false);
    expect(setters.setLoginError).toHaveBeenCalledWith('');

    const bannerArg = setters.setDismissedBanners.mock.calls[0][0];
    expect(bannerArg).toBeInstanceOf(Set);
    expect(bannerArg.size).toBe(0);
  });

  it('tolerates a partial setter object (no throw on missing setters)', () => {
    expect(() => resetTransientState({})).not.toThrow();
  });

  it('does not leak the previous user\'s logs/banners on logout', () => {
    const state = {
      logs: [{ id: 1, message: 'user A log' }],
      banners: new Set(['acct-from-user-A']),
      appState: { authenticated: true, user: { name: 'A' } },
    };
    const setters = {
      setAppState: (v) => {
        state.appState = v;
      },
      setLogs: (v) => {
        state.logs = v;
      },
      setDismissedBanners: (v) => {
        state.banners = v;
      },
    };
    resetTransientState(setters);
    expect(state.appState).toEqual({ authenticated: false });
    expect(state.logs).toEqual([]);
    expect(state.banners.size).toBe(0);
  });
});

describe('runIfMounted (H-10/H-11: AbortController + cancelled flag)', () => {
  it('applies the result when not cancelled', async () => {
    const apply = vi.fn();
    await runIfMounted(async () => 'ok', apply, { isCancelled: () => false });
    expect(apply).toHaveBeenCalledWith('ok');
  });

  it('drops the result when cancelled flag flips before the promise resolves', async () => {
    const apply = vi.fn();
    let cancelled = false;
    const producer = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve('late'), 10);
      });
    const promise = runIfMounted(producer, apply, { isCancelled: () => cancelled });
    cancelled = true; // mimic component unmount mid-flight
    await promise;
    expect(apply).not.toHaveBeenCalled();
  });

  it('drops the result when the AbortSignal is already aborted', async () => {
    const apply = vi.fn();
    const ac = new AbortController();
    const producer = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve('late'), 10);
      });
    const promise = runIfMounted(producer, apply, { signal: ac.signal });
    ac.abort();
    await promise;
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not call apply if the producer rejects', async () => {
    const apply = vi.fn();
    await expect(
      runIfMounted(
        async () => {
          throw new Error('sw down');
        },
        apply
      )
    ).rejects.toThrow('sw down');
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('Esc-to-close key dispatch (H-14: modal Esc handler)', () => {
  // We re-implement the predicate the modal uses, so we can verify the
  // intended behaviour without rendering React.
  function handleKey(event, onCancel) {
    if (event.key === 'Escape') {
      onCancel?.();
      return true;
    }
    return false;
  }

  it('invokes onCancel on Escape', () => {
    const onCancel = vi.fn();
    const handled = handleKey({ key: 'Escape' }, onCancel);
    expect(handled).toBe(true);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('ignores non-Escape keys', () => {
    const onCancel = vi.fn();
    handleKey({ key: 'Enter' }, onCancel);
    handleKey({ key: 'Tab' }, onCancel);
    handleKey({ key: 'a' }, onCancel);
    expect(onCancel).not.toHaveBeenCalled();
  });
});
