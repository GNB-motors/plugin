import { useState, useEffect, useRef, useCallback, useMemo, useId } from 'react';
import './Popup.css';
import { resetTransientState } from './lifecycle.js';
import { useCountUp } from './useCountUp.js';
import IalertSection from './IalertSection.jsx';
import {
  IconBack,
  IconClose,
  IconList,
  IconLogout,
  IconPlus,
  IconRefresh,
  IconSync,
  Pill,
  RowMenu,
} from './ui.jsx';
import { ago, until, minutesUntil } from './time.js';

const AUTO_REFRESH_MS = 30_000;
const MARK_SRC = '/icons/icon48.png';

// ── helpers ───────────────────────────────────────────────────────────────────
function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function deriveStatus(acc, nowMs) {
  if (acc.status === 'NEEDS_REAUTH') return 'expired';
  const exp = acc.expiresAt ? new Date(acc.expiresAt).getTime() : null;
  if (exp == null) return 'linked';
  const rem = (exp - nowMs) / 1000;
  if (rem <= 0) return 'expired';
  if (rem <= 3600) return 'expiring';
  return 'linked';
}

const count = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

// ── FleetEdge ─────────────────────────────────────────────────────────────────

function FleetEdgeAccountRow({ account, onAction, style }) {
  const now = useNow();
  const status = deriveStatus(account, now);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(account.friendlyName);
  const [syncedName, setSyncedName] = useState(account.friendlyName);

  // Re-sync the rename draft when the account's name changes from outside (adjusting state during render).
  if (account.friendlyName !== syncedName) {
    setSyncedName(account.friendlyName);
    setDraftName(account.friendlyName);
  }

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== account.friendlyName) {
      onAction('renameAccount', { accountId: account.accountId, friendlyName: trimmed });
    } else {
      setDraftName(account.friendlyName);
    }
  };
  const reconnect = () => onAction('reconnectAccount', { accountId: account.accountId });

  const synced = ago(account.lastPullAt, now);
  const mins = minutesUntil(account.expiresAt, now);

  return (
    <div className="acc" style={style}>
      <div className="acc-main">
        <div className="acc-name" title={account.fleetId || undefined}>
          {renaming ? (
            <input
              autoFocus
              aria-label="Account name"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitRename();
                if (e.key === 'Escape') {
                  setDraftName(account.friendlyName);
                  setRenaming(false);
                }
              }}
            />
          ) : (
            account.friendlyName
          )}
        </div>
        <div className="acc-meta">
          {plural(account.vehicleCount ?? 0, 'vehicle', 'vehicles')}
          {status === 'expiring'
            ? ` · ends ${mins != null && mins > 0 ? `in ${mins} min` : 'soon'}`
            : synced
              ? ` · synced ${synced}`
              : ''}
        </div>
      </div>
      <div className="acc-side">
        {status === 'linked' && <Pill tone="ok">Connected</Pill>}
        {status === 'expiring' && (
          <button
            type="button"
            className="btn btn--sm btn--warn-soft"
            onClick={reconnect}
            title="The session ends soon. Reconnect to keep syncing."
          >
            Renew
          </button>
        )}
        {status === 'expired' && (
          <button type="button" className="btn btn--sm btn--crit-soft" onClick={reconnect}>
            Reconnect
          </button>
        )}
        <RowMenu
          label={`Options for ${account.friendlyName}`}
          items={[
            { label: 'Rename', onSelect: () => setRenaming(true) },
            { label: 'Reconnect', onSelect: reconnect },
            'divider',
            {
              label: 'Disconnect',
              danger: true,
              onSelect: () => onAction('disconnectAccount', { accountId: account.accountId }),
            },
          ]}
        />
      </div>
    </div>
  );
}

function FleetEdgeCard({ accounts, pull, onAction, style }) {
  const now = useNow();
  const hasActive = accounts.some((a) => deriveStatus(a, now) === 'linked');
  const vehicles = accounts.reduce((n, a) => n + (a.vehicleCount ?? 0), 0);
  const pulling = Boolean(pull?.pullingNow);
  const last = ago(pull?.lastRunAt, now);
  const next = until(pull?.nextRunAt, now);

  let sub = 'Not connected';
  if (accounts.length) {
    sub = `${plural(accounts.length, 'account', 'accounts')} · ${plural(vehicles, 'vehicle', 'vehicles')}`;
  }
  const syncNote = pulling
    ? 'Syncing now…'
    : [last && `Synced ${last}`, next && next !== 'now' && `next ${next}`]
        .filter(Boolean)
        .join(' · ') || 'Waiting for the first sync';

  return (
    <section
      className={`prov${pulling ? ' prov--busy' : ''}`}
      aria-labelledby="prov-fe"
      aria-busy={pulling}
      style={style}
    >
      <header className="prov-head">
        <span className="prov-logo prov-logo--tata" aria-hidden="true">
          TATA
        </span>
        <div className="prov-title">
          <div className="prov-name" id="prov-fe">
            Tata FleetEdge
          </div>
          <div className="prov-sub">{sub}</div>
        </div>
        {accounts.length > 0 && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => onAction('connectAccount')}
          >
            <IconPlus /> Add
          </button>
        )}
      </header>

      {accounts.length === 0 ? (
        <div className="prov-empty">
          <ol className="prov-steps">
            <li>Open FleetEdge in a tab and sign in.</li>
            <li>Come back here and press Connect.</li>
          </ol>
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => onAction('connectAccount')}
          >
            Connect FleetEdge
          </button>
        </div>
      ) : (
        <>
          <div className="prov-rows">
            {accounts.map((a, i) => (
              <FleetEdgeAccountRow
                key={a.accountId}
                account={a}
                onAction={onAction}
                style={{ '--i': i }}
              />
            ))}
          </div>
          <footer className="prov-foot">
            <span className="prov-foot-note">{syncNote}</span>
            <button
              type="button"
              className="btn btn--sm btn--secondary"
              disabled={!hasActive || pulling}
              title={hasActive ? undefined : 'Reconnect an account first'}
              onClick={() => onAction('pullNow')}
            >
              <IconSync className={pulling ? 'spin' : ''} /> {pulling ? 'Syncing' : 'Sync now'}
            </button>
          </footer>
        </>
      )}
    </section>
  );
}

// ── audit tasks ───────────────────────────────────────────────────────────────

function TaskStats({ metrics, style }) {
  const m = metrics || {};
  const waiting = (m.pending || 0) + (m.inProgress || 0);
  const done = m.completed || 0;
  const flagged = m.flagged || 0;
  const noData = m.noData || 0;
  const caughtUp = waiting === 0 && done > 0;

  // Animated count-up values
  const waitingVal = useCountUp(waiting);
  const doneVal = useCountUp(done);
  const flaggedVal = useCountUp(flagged);

  return (
    <section className="stats" aria-labelledby="stats-title" style={style}>
      <div className="stats-head">
        <span className="stats-title" id="stats-title">
          Audit tasks
        </span>
        <span className={`stats-state${caughtUp ? ' stats-state--ok' : ''}`}>
          {caughtUp ? 'All caught up' : waiting ? `${count(waiting)} to sync` : ''}
        </span>
      </div>
      <div className="stats-grid">
        <div className={`stat${waiting ? ' stat--warn' : ''}`}>
          <div className="stat-value">{count(waitingVal)}</div>
          <div className="stat-label">Waiting</div>
        </div>
        <div className="stat">
          <div className="stat-value">{count(doneVal)}</div>
          <div className="stat-label">Done</div>
        </div>
        <div className={`stat${flagged ? ' stat--crit' : ''}`}>
          <div className="stat-value">{count(flaggedVal)}</div>
          <div className="stat-label">Flagged</div>
        </div>
      </div>
      {noData > 0 && (
        <p className="stats-note">
          {plural(noData, 'task has', 'tasks have')} no FleetEdge data yet.
        </p>
      )}
    </section>
  );
}

// ── sign in ───────────────────────────────────────────────────────────────────

function LoginView({ onAction, loading, error }) {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const idField = useId();
  const pwField = useId();
  const submit = (e) => {
    e.preventDefault();
    if (!id.trim() || !pw.trim() || loading) return;
    onAction('login', { emailOrMobile: id.trim(), password: pw });
  };
  return (
    <div className="login">
      <div className="login-head">
        <img className="gnb-mark" src={MARK_SRC} alt="" />
        <h1>Sign in to GNB Edge</h1>
        <p>Use your GNB account to connect your fleet data.</p>
      </div>
      <form onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={idField}>Email or mobile number</label>
          <input
            id={idField}
            value={id}
            onChange={(e) => setId(e.target.value)}
            autoComplete="username"
            autoFocus
          />
        </div>
        <div className="field">
          <label htmlFor={pwField}>Password</label>
          <input
            id={pwField}
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            autoComplete="current-password"
          />
        </div>
        {error && (
          <p className="login-error" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          className="btn btn--primary btn--block"
          disabled={loading || !id.trim() || !pw.trim()}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="login-foot">Version {chrome.runtime.getManifest().version}</div>
    </div>
  );
}

// ── activity log ──────────────────────────────────────────────────────────────

function LogsView({ logs, onAction }) {
  const sorted = useMemo(
    () => [...(logs || [])].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    [logs]
  );
  return (
    <>
      <div className="logs-head">
        <button
          type="button"
          className="gnb-icon-btn"
          onClick={() => onAction('viewHome')}
          aria-label="Back"
        >
          <IconBack />
        </button>
        <h2>Activity log</h2>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onAction('refreshLogs')}
        >
          <IconRefresh /> Refresh
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onAction('clearLogs')}
          disabled={sorted.length === 0}
        >
          Clear
        </button>
      </div>
      <div className="logs-list">
        {sorted.length === 0 ? (
          <div className="logs-empty">
            <strong>Nothing logged yet</strong>
            Syncs and errors will show up here.
          </div>
        ) : (
          sorted.map((log, i) => (
            <div key={i} className={`log log--${String(log.level || '').toLowerCase()}`}>
              <span className="log-dot" aria-hidden="true" />
              <span className="log-msg">{log.message}</span>
              <span className="log-meta">
                {new Date(log.timestamp).toLocaleString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
                {log.module ? ` · ${log.module}` : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </>
  );
}

// ── overlays ──────────────────────────────────────────────────────────────────

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div
      className={`toast${toast.kind ? ` toast--${toast.kind}` : ''}`}
      key={toast.id}
      role="status"
    >
      <span className="toast-dot" aria-hidden="true" />
      <span>{toast.message}</span>
    </div>
  );
}

function ExpiredBanner({ account, onAction, onDismiss, style }) {
  const now = useNow();
  const expiring = deriveStatus(account, now) === 'expiring';
  return (
    <div
      className={`notice ${expiring ? 'notice--warn' : 'notice--crit'}`}
      role="alert"
      style={style}
    >
      <div className="notice-text">
        <strong>{account.friendlyName}</strong>{' '}
        {expiring ? 'stops syncing soon.' : 'has stopped syncing.'} Reconnect to keep its data
        coming in.
        <div className="notice-actions">
          <button
            type="button"
            className={`btn btn--sm ${expiring ? 'btn--warn-soft' : 'btn--crit-soft'}`}
            onClick={() => onAction('reconnectAccount', { accountId: account.accountId })}
          >
            Reconnect
          </button>
        </div>
      </div>
      <button type="button" className="notice-close" onClick={onDismiss} aria-label="Dismiss">
        <IconClose />
      </button>
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  const modalRef = useRef(null);
  const cancelBtnRef = useRef(null);
  const titleId = useId();

  // Esc to close + simple focus trap (Tab cycles between focusable elements).
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel?.();
        return;
      }
      if (e.key === 'Tab' && modalRef.current) {
        const focusables = modalRef.current.querySelectorAll(
          'button, [href], input, [tabindex]:not([tabindex="-1"])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    // Auto-focus the cancel button so Esc/Enter feel natural.
    cancelBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id={titleId}>{title}</h3>
        <p>{body}</p>
        <div className="modal-actions">
          <button
            type="button"
            className="btn btn--secondary"
            ref={cancelBtnRef}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? 'btn--danger' : 'btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Popup ────────────────────────────────────────────────────────────────

export default function Popup() {
  const [appState, setAppState] = useState(null);
  const [view, setView] = useState('home');
  const [logs, setLogs] = useState([]);
  const [toast, setToast] = useState(null);
  const [confirming, setConfirming] = useState(null);
  // G-1: tab picker state — set when background returns needsTabPick:true
  const [tabPicker, setTabPicker] = useState(null); // { choices: [{tabId, fleetId, displayName}] }
  const [tabPickerSelected, setTabPickerSelected] = useState(null);
  const [dismissedBanners, setDismissedBanners] = useState(new Set());
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const toastTimer = useRef(null);
  // Tracks whether the component is still mounted so async tasks can bail out
  // before calling setState — avoids React "setState on unmounted" warnings and
  // prevents a popup that was closed/reopened from rendering pre-close data.
  const mountedRef = useRef(true);
  // View ref so refreshStatus can read the latest value without re-binding the
  // interval on every navigation (was previously a stale-closure source).
  const viewRef = useRef(view);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  // Home slides in only when coming back from the activity log, not on every open.
  const [prevView, setPrevView] = useState(view);
  const [backFromLogs, setBackFromLogs] = useState(false);
  if (view !== prevView) {
    setPrevView(view);
    setBackFromLogs(prevView === 'logs' && view === 'home');
  }

  const showToast = useCallback((message, kind = '') => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now() + Math.random(), message, kind });
    toastTimer.current = setTimeout(() => {
      if (mountedRef.current) setToast(null);
    }, 3000);
  }, []);

  const refreshStatus = useCallback(async (signal) => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      if (signal?.aborted || !mountedRef.current) return;
      if (!res) return; // SW restarting — leave previous state, retry next tick
      setAppState(res);
      if (res.authenticated && viewRef.current === 'login') setView('home');
      if (!res.authenticated) setView('login');
    } catch {
      /* SW not ready — will retry */
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const ac = new AbortController();
    refreshStatus(ac.signal);
    const id = setInterval(() => refreshStatus(ac.signal), AUTO_REFRESH_MS);
    return () => {
      mountedRef.current = false;
      ac.abort();
      clearInterval(id);
      clearTimeout(toastTimer.current);
    };
  }, [refreshStatus]);

  const onAction = useCallback(
    async (type, payload) => {
      try {
        switch (type) {
          case 'login': {
            setLoginLoading(true);
            setLoginError('');
            // Clear any leftover state from a previous user session before
            // the new session's data arrives — prevents stale logs / banners.
            setLogs([]);
            setDismissedBanners(new Set());
            const res = await chrome.runtime.sendMessage({ type: 'LOGIN', ...payload });
            if (!res) throw new Error('Service worker unavailable');
            if (res.error) {
              setLoginError(res.error);
              throw new Error(res.error);
            }
            await refreshStatus();
            setView('home');
            break;
          }

          case 'logout': {
            await chrome.runtime.sendMessage({ type: 'LOGOUT' });
            resetTransientState({
              setAppState,
              setView,
              setLogs,
              setToast,
              setConfirming,
              setDismissedBanners,
              setLoginLoading,
              setLoginError,
            });
            showToast('Signed out', 'ok');
            break;
          }

          case 'connectAccount': {
            const granted = await chrome.permissions.request({
              origins: ['https://fleetedge.home.tatamotors/*', 'https://cvpauth.api.tatamotors/*'],
            });
            if (!granted) {
              showToast('Permission denied — allow access to the fleet portal', 'err');
              break;
            }
            showToast('Connecting to FleetEdge…');
            // G-1: pass tabId if user already chose a tab from the picker.
            const connectMsg = { type: 'CONNECT_FLEETEDGE' };
            if (payload?.tabId) connectMsg.tabId = payload.tabId;
            const res = await chrome.runtime.sendMessage(connectMsg);
            if (res.success) {
              setTabPicker(null);
              setTabPickerSelected(null);
              if (res.noRefreshToken && res.refreshRejected === 'DIFFERENT_USER') {
                showToast(
                  'Connected, but this browser is signed in to FleetEdge as a DIFFERENT user, so the account cannot renew itself and will stop in 48 h. Sign in to FleetEdge as this account’s own user, then connect again.',
                  'err'
                );
              } else if (res.noRefreshToken) {
                showToast(
                  'Connected, but NO refresh token was captured — this account will die when its access token lapses. Reload FleetEdge, wait for the map to load, then connect again.',
                  'err'
                );
              } else if (res.sessionCleared) {
                showToast(
                  'Connected ✓ — FleetEdge tab closed and signed out locally; log in again anytime.',
                  'ok'
                );
              } else {
                showToast(`Connected ✓ (${res.vehicleCount ?? 0} vehicles)`, 'ok');
              }
              await refreshStatus();
            } else if (res.needsTabPick) {
              // G-1: Background found multiple tabs — surface a chooser modal.
              setTabPicker({ choices: res.choices || [] });
              setTabPickerSelected(res.choices?.[0]?.tabId ?? null);
            } else {
              showToast(res.error || 'Connection failed', 'err');
            }
            break;
          }

          case 'reconnectAccount': {
            const { accountId } = payload;
            const granted = await chrome.permissions.request({
              origins: ['https://fleetedge.home.tatamotors/*', 'https://cvpauth.api.tatamotors/*'],
            });
            if (!granted) {
              showToast('Permission denied', 'err');
              break;
            }
            showToast('Reconnecting…');
            const res = await chrome.runtime.sendMessage({ type: 'RECONNECT_ACCOUNT', accountId });
            if (res.success) {
              if (res.sessionCleared) {
                showToast(
                  'Reconnected ✓ — FleetEdge tab closed and signed out locally; log in again anytime.',
                  'ok'
                );
              } else {
                showToast('Reconnected ✓', 'ok');
              }
              setDismissedBanners((prev) => {
                const s = new Set(prev);
                s.delete(accountId);
                return s;
              });
              await refreshStatus();
            } else {
              showToast(res.error || 'Reconnect failed', 'err');
            }
            break;
          }

          case 'disconnectAccount': {
            const { accountId } = payload;
            const res = await chrome.runtime.sendMessage({ type: 'DISCONNECT_ACCOUNT', accountId });
            if (res.success) {
              showToast('Account disconnected', 'ok');
              await refreshStatus();
            } else showToast(res.error || 'Disconnect failed', 'err');
            break;
          }

          case 'renameAccount': {
            const { accountId, friendlyName } = payload;
            await chrome.runtime.sendMessage({ type: 'RENAME_ACCOUNT', accountId, friendlyName });
            await refreshStatus();
            break;
          }

          case 'pullNow': {
            showToast('Pulling from FleetEdge…');
            const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_PROCESS' });
            if (res.success) {
              showToast('Pull triggered ✓', 'ok');
              await refreshStatus();
            } else {
              showToast(res.error || 'Pull failed', 'err');
            }
            break;
          }

          case 'viewLogs': {
            const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS', limit: 100 });
            setLogs(res.logs || []);
            setView('logs');
            break;
          }

          case 'refreshLogs': {
            const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS', limit: 100 });
            setLogs(res.logs || []);
            break;
          }

          case 'viewHome':
            setView('home');
            break;

          case 'clearLogs':
            setConfirming({
              title: 'Clear logs?',
              body: 'All system log entries will be removed.',
              confirmLabel: 'Clear logs',
              danger: true,
              run: async () => {
                await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
                setLogs([]);
                showToast('Logs cleared', 'ok');
              },
            });
            break;

          case 'clearData':
            setConfirming({
              title: 'Clear all data?',
              body: "Disconnects every FleetEdge account and wipes local state. You'll have to sign in and reconnect.",
              confirmLabel: 'Clear everything',
              danger: true,
              run: async () => {
                try {
                  const res = await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
                  if (!res?.success) {
                    throw new Error(res?.error || 'Failed to clear data');
                  }
                  resetTransientState({
                    setAppState,
                    setView,
                    setLogs,
                    setToast,
                    setConfirming,
                    setDismissedBanners,
                    setLoginLoading,
                    setLoginError,
                  });
                  showToast('All data cleared', 'ok');
                } catch (err) {
                  showToast(err?.message || 'Failed to clear data', 'err');
                }
              },
            });
            break;

          case 'dismissBanner':
            setDismissedBanners((prev) => new Set([...prev, payload?.accountId]));
            break;

          default:
            break;
        }
      } catch (err) {
        showToast(err.message || 'Something went wrong', 'err');
      } finally {
        if (type === 'login') setLoginLoading(false);
      }
    },
    [refreshStatus, showToast]
  );

  // ── loading splash ───────────────────────────────────────────────────────
  if (appState === null) {
    return (
      <div className="gnb-popup">
        <div className="splash">Loading…</div>
      </div>
    );
  }

  // ── sign in ──────────────────────────────────────────────────────────────
  if (!appState.authenticated || view === 'login') {
    return (
      <div className="gnb-popup">
        <LoginView onAction={onAction} loading={loginLoading} error={loginError} />
        <Toast toast={toast} />
      </div>
    );
  }

  // ── activity log ─────────────────────────────────────────────────────────
  if (view === 'logs') {
    return (
      <div className="gnb-popup">
        <div className="view-wrapper view-wrapper--enter-right">
          <LogsView logs={logs} onAction={onAction} />
        </div>
        <Toast toast={toast} />
        {confirming && (
          <ConfirmModal
            {...confirming}
            onConfirm={async () => {
              const run = confirming.run;
              setConfirming(null);
              try {
                await run?.();
              } catch (err) {
                showToast(err?.message || 'Action failed', 'err');
              }
            }}
            onCancel={() => setConfirming(null)}
          />
        )}
      </div>
    );
  }

  // ── home ─────────────────────────────────────────────────────────────────
  const fe = appState.fleetEdge || { accounts: [], pull: {} };
  const accounts = fe.accounts || [];
  const expiredAcc = accounts.find(
    (a) => !dismissedBanners.has(a.accountId) && deriveStatus(a, Date.now()) === 'expired'
  );
  const userName = (appState.user?.name || '').trim();
  const role = String(appState.user?.role || '')
    .toLowerCase()
    .replace(/_/g, ' ');

  return (
    <div className="gnb-popup">
      <header className="gnb-header">
        <img className="gnb-mark" src={MARK_SRC} alt="" />
        <div className="gnb-brand">
          <div className="gnb-brand-name">GNB Edge</div>
          <div className="gnb-brand-sub">
            {userName || 'Signed in'}
            {role ? ` · ${role.charAt(0).toUpperCase()}${role.slice(1)}` : ''}
          </div>
        </div>
        <span className="gnb-avatar" aria-hidden="true">
          {(userName || 'U').charAt(0).toUpperCase()}
        </span>
        <button
          type="button"
          className="gnb-icon-btn"
          title="Sign out"
          aria-label="Sign out"
          onClick={() => onAction('logout')}
        >
          <IconLogout />
        </button>
      </header>

      <main className="gnb-body">
        <div className={`view-wrapper${backFromLogs ? ' view-wrapper--enter-left' : ''}`}>
          {expiredAcc && (
            <ExpiredBanner
              account={expiredAcc}
              onAction={onAction}
              onDismiss={() => onAction('dismissBanner', { accountId: expiredAcc.accountId })}
              style={{ '--i': 0 }}
            />
          )}

          <FleetEdgeCard
            accounts={accounts}
            pull={fe.pull || {}}
            onAction={onAction}
            style={{ '--i': expiredAcc ? 1 : 0 }}
          />

          <IalertSection
            showToast={showToast}
            confirm={setConfirming}
            style={{ '--i': expiredAcc ? 2 : 1 }}
          />

          {accounts.length > 0 && (
            <TaskStats metrics={appState.metrics} style={{ '--i': expiredAcc ? 3 : 2 }} />
          )}
        </div>
      </main>

      <footer className="gnb-footer">
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          onClick={() => onAction('viewLogs')}
        >
          <IconList /> Activity log
        </button>
        <button
          type="button"
          className="btn btn--sm btn--ghost danger"
          onClick={() => onAction('clearData')}
        >
          Reset extension
        </button>
      </footer>

      <Toast toast={toast} />
      {confirming && (
        <ConfirmModal
          {...confirming}
          onConfirm={() => {
            confirming.run?.();
            setConfirming(null);
          }}
          onCancel={() => setConfirming(null)}
        />
      )}
      {/* G-1: Tab picker — shown when multiple FleetEdge tabs are open */}
      {tabPicker && (
        <div className="modal-backdrop" onClick={() => setTabPicker(null)}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a FleetEdge tab"
            onClick={(e) => e.stopPropagation()}
          >
            <h3>Which FleetEdge account?</h3>
            <p>More than one FleetEdge tab is open. Pick the account to connect.</p>
            <div className="modal-choices">
              {tabPicker.choices.map((c) => (
                <label key={c.tabId} className="modal-choice">
                  <input
                    type="radio"
                    name="tabPick"
                    value={c.tabId}
                    checked={tabPickerSelected === c.tabId}
                    onChange={() => setTabPickerSelected(c.tabId)}
                  />
                  <span>
                    {c.displayName}
                    {c.fleetId && c.displayName !== c.fleetId ? ` (${c.fleetId})` : ''}
                  </span>
                </label>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => setTabPicker(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={!tabPickerSelected}
                onClick={() => onAction('connectAccount', { tabId: tabPickerSelected })}
              >
                Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
