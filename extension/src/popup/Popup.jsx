import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import './Popup.css';

const AUTO_REFRESH_MS = 30_000;

// ── icons ─────────────────────────────────────────────────────────────────────
const Icon = {
  Logout:   (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  Plus:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>,
  Refresh:  (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>,
  Reconnect:(p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}><path d="M21 12a9 9 0 1 1-3-6.7"/><polyline points="21 4 21 10 15 10"/></svg>,
  Dots:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" {...p}><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>,
  Back:     (p) => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="15 18 9 12 15 6"/></svg>,
  Logs:     (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>,
  Trash:    (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>,
  Play:     (p) => <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" {...p}><polygon points="6 4 20 12 6 20 6 4"/></svg>,
  Close:    (p) => <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" {...p}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  Antenna:  (p) => <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/></svg>,
};

// ── helpers ───────────────────────────────────────────────────────────────────
function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function fmtRemain(secs) {
  if (secs == null) return '—';
  if (secs <= 0) return '00:00:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function fmtClock(d) {
  if (!d) return '—';
  return new Date(d).toTimeString().slice(0, 5);
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

// ── sub-components ────────────────────────────────────────────────────────────

function StatusChip({ kind, children }) {
  return <span className={`gnb-chip ${kind}`}><span className="dot" />{children}</span>;
}

function ConnectivitySummary({ accounts, pull }) {
  const now = useNow(1000);
  const buckets = useMemo(() => {
    let ok = 0, warn = 0, err = 0;
    for (const a of accounts) {
      const s = deriveStatus(a, now);
      if (s === 'linked') ok++;
      else if (s === 'expiring') warn++;
      else err++;
    }
    return { ok, warn, err };
  }, [accounts, now]);

  const pulling = pull?.pullingNow;
  return (
    <div className={`gnb-connectivity${pulling ? ' pulling' : ''}`}>
      <div className="gnb-conn-line">
        <span className="gnb-conn-seg ok"><b>{buckets.ok}</b> connected</span>
        {buckets.warn > 0 && <span className="gnb-conn-seg warn"><b>{buckets.warn}</b> expiring</span>}
        {buckets.err  > 0 && <span className="gnb-conn-seg error"><b>{buckets.err}</b> re-auth</span>}
        <span className="gnb-conn-seg">last <b>{fmtClock(pull?.lastRunAt)}</b></span>
        <span className="gnb-conn-seg">next <b>~{fmtClock(pull?.nextRunAt)}</b></span>
        {pulling && (
          <span className="gnb-conn-pulse">
            <span className="dot" /> pulling {typeof pulling === 'number' ? `(${pulling})` : ''}
          </span>
        )}
      </div>
    </div>
  );
}

function AccountCard({ account, onAction }) {
  const now = useNow(1000);
  const status = deriveStatus(account, now);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(account.friendlyName);
  const [syncedName, setSyncedName] = useState(account.friendlyName);
  const menuRef = useRef(null);

  // Re-sync the rename draft when the account's name changes from outside (adjusting state during render).
  if (account.friendlyName !== syncedName) {
    setSyncedName(account.friendlyName);
    setDraftName(account.friendlyName);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [menuOpen]);

  const remSecs = account.expiresAt
    ? Math.max(0, Math.floor((new Date(account.expiresAt).getTime() - now) / 1000))
    : null;

  const cardClass = `gnb-card is-${status === 'linked' ? 'ok' : status === 'expiring' ? 'warn' : 'error'}`;

  const commitRename = () => {
    setRenaming(false);
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== account.friendlyName) {
      onAction('renameAccount', { accountId: account.accountId, friendlyName: trimmed });
    } else {
      setDraftName(account.friendlyName);
    }
  };

  return (
    <div className={cardClass}>
      <div className="gnb-card-top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="gnb-card-name">
            {renaming ? (
              <input
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') { setDraftName(account.friendlyName); setRenaming(false); }
                }}
              />
            ) : account.friendlyName}
          </div>
          <div className="gnb-fleetid">{account.fleetId}</div>
        </div>
        <div className="gnb-menu-wrap" ref={menuRef}>
          <button className="gnb-menu-btn" onClick={() => setMenuOpen((v) => !v)} aria-label="Account menu">
            <Icon.Dots />
          </button>
          {menuOpen && (
            <div className="gnb-menu-pop">
              <button onClick={() => { setMenuOpen(false); setRenaming(true); }}>Rename</button>
              <button onClick={() => { setMenuOpen(false); onAction('reconnectAccount', { accountId: account.accountId }); }}>Reconnect</button>
              <div className="gnb-divider" />
              <button className="danger" onClick={() => { setMenuOpen(false); onAction('disconnectAccount', { accountId: account.accountId }); }}>Disconnect</button>
            </div>
          )}
        </div>
      </div>

      <div className="gnb-card-row2">
        {status === 'linked'    && <StatusChip kind="ok">Connected&nbsp;·&nbsp;<span className="gnb-countdown">{fmtRemain(remSecs)}</span></StatusChip>}
        {status === 'expiring'  && <StatusChip kind="warn">Expires&nbsp;<span className="gnb-countdown">{fmtRemain(remSecs)}</span></StatusChip>}
        {status === 'expired'   && <StatusChip kind="error">Expired</StatusChip>}
        <span className="count">{account.vehicleCount ?? 0} vehicles</span>
      </div>

      <div className="gnb-card-row3">
        <span>pulled {fmtClock(account.lastPullAt)}</span>
        {status === 'expiring' && (
          <button className="reconnect" onClick={() => onAction('reconnectAccount', { accountId: account.accountId })}>
            <Icon.Reconnect /> Reconnect
          </button>
        )}
        {status === 'expired' && (
          <button className="reconnect error" onClick={() => onAction('reconnectAccount', { accountId: account.accountId })}>
            <Icon.Reconnect /> Reconnect
          </button>
        )}
      </div>
    </div>
  );
}

function MetricsGrid({ metrics }) {
  const m = metrics || {};
  const allDone = (m.pending || 0) + (m.inProgress || 0) === 0 && (m.completed || 0) > 0;
  const awaiting = (m.pending || 0) + (m.noData || 0);
  return (
    <div className="gnb-metrics">
      <div className="gnb-metric-grid">
        {[
          { label: 'Pending',   value: m.pending,    tone: (m.pending||0)    > 0 ? 'warn'   : 'zero' },
          { label: 'In Prog.',  value: m.inProgress, tone: (m.inProgress||0) > 0 ? 'warn'   : 'zero' },
          { label: 'Completed', value: m.completed,  tone: (m.completed||0)  > 0 ? 'ok'     : 'zero' },
          { label: 'Flagged',   value: m.flagged,    tone: (m.flagged||0)    > 0 ? 'danger' : 'zero' },
          { label: 'No Data',   value: m.noData,     tone: (m.noData||0)     > 0 ? 'warn'   : 'zero' },
        ].map(({ label, value, tone }) => (
          <div key={label} className={`gnb-metric ${tone}`}>
            <span className="gnb-metric-label">{label}</span>
            <span className="gnb-metric-value">{value ?? 0}</span>
          </div>
        ))}
      </div>
      <div className={`gnb-metric-footer${allDone ? ' ok' : awaiting > 0 ? ' warn' : ''}`}>
        <span className="dot" />
        {allDone ? 'all caught up' : `${awaiting} awaiting pull`}
      </div>
    </div>
  );
}

function EmptyAccounts({ onAction }) {
  return (
    <div className="gnb-empty">
      <div className="gnb-empty-illus"><span style={{ color: 'var(--accent)' }}><Icon.Antenna /></span></div>
      <h3>Connect your first FleetEdge account</h3>
      <p>Open a FleetEdge tab, log in, then click below — we&apos;ll capture the session and start syncing tasks.</p>
      <button className="gnb-btn primary full" style={{ marginTop: 14 }} onClick={() => onAction('connectAccount')}>
        <Icon.Plus /> Connect FleetEdge account
      </button>
    </div>
  );
}

function LoginView({ onAction, loading, error }) {
  const [id, setId] = useState('');
  const [pw, setPw] = useState('');
  const submit = (e) => {
    e.preventDefault();
    if (!id.trim() || !pw.trim() || loading) return;
    onAction('login', { emailOrMobile: id.trim(), password: pw });
  };
  return (
    <div className="gnb-login">
      <div className="gnb-login-head">
        <svg className="gnb-logo" viewBox="0 0 24 24" width="56" height="56" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" style={{ display:'block', margin:'0 auto 14px', borderRadius:14 }}><rect x="2" y="3" width="14" height="14" rx="2"/><path d="M16 8l4 2v6h-4"/><circle cx="6" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></svg>
        <h1>gnbedge</h1>
        <div className="tagline">Fleet · Fuel · Audit</div>
      </div>
      <form className="gnb-form" onSubmit={submit}>
        <div className="gnb-field">
          <label>Email or Mobile</label>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="you@company.com" autoFocus />
        </div>
        <div className="gnb-field">
          <label>Password</label>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />
        </div>
        {error && <div className="gnb-login-err">{error}</div>}
        <button type="submit" className="gnb-btn primary full" disabled={loading || !id.trim() || !pw.trim()} style={{ marginTop: 4 }}>
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <div className="gnb-login-foot">v 0.0.0.3 · <span className="accent">secure session</span></div>
    </div>
  );
}

function LogsView({ logs, onAction }) {
  const sorted = useMemo(
    () => [...(logs || [])].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
    [logs]
  );
  return (
    <>
      <div className="gnb-logs-head">
        <button className="back" onClick={() => onAction('viewHome')} aria-label="Back"><Icon.Back /></button>
        <h2>System logs</h2>
        <span className="count">{sorted.length}</span>
        <div className="actions">
          <button className="gnb-btn ghost sm" onClick={() => onAction('refreshLogs')}><Icon.Refresh /> Refresh</button>
          <button className="gnb-btn danger-ghost sm" onClick={() => onAction('clearLogs')}><Icon.Trash /> Clear</button>
        </div>
      </div>
      <div className="gnb-logs-list">
        {sorted.length === 0 && (
          <div className="gnb-empty" style={{ marginTop: 8 }}><h3>No logs yet</h3><p>Pull events and errors will appear here.</p></div>
        )}
        {sorted.map((log, i) => (
          <div key={i} className={`gnb-log ${log.level.toLowerCase()}`}>
            <span className="ts">{new Date(log.timestamp).toTimeString().slice(0, 8)}</span>
            <span className="lvl">{log.level}</span>
            <span className="msg"><span className="mod">[{log.module}]</span>{log.message}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function Toast({ toast }) {
  if (!toast) return null;
  return (
    <div className={`gnb-toast ${toast.kind || ''}`} key={toast.id}>
      <span className="dot" /><span>{toast.message}</span>
    </div>
  );
}

function ExpiredBanner({ account, onAction, onDismiss }) {
  const now = useNow(1000);
  const amber = deriveStatus(account, now) === 'expiring';
  return (
    <div className={`gnb-banner${amber ? ' amber' : ''}`}>
      <div className="gnb-banner-text">
        FleetEdge session for <strong>{account.friendlyName}</strong> {amber ? 'expires soon' : 'expired'} — reconnect to keep pulling.
      </div>
      <button className="gnb-btn ghost sm" onClick={() => onAction('reconnectAccount', { accountId: account.accountId })}>
        <Icon.Reconnect /> Reconnect
      </button>
      <button className="close" onClick={onDismiss} aria-label="Dismiss"><Icon.Close /></button>
    </div>
  );
}

function ConfirmModal({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onCancel }) {
  return (
    <div className="gnb-modal-backdrop" onClick={onCancel}>
      <div className="gnb-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="gnb-modal-actions">
          <button className="gnb-btn ghost sm" onClick={onCancel}>Cancel</button>
          <button className={`gnb-btn sm ${danger ? 'danger-ghost' : 'primary'}`} onClick={onConfirm}>{confirmLabel}</button>
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
  const [dismissedBanners, setDismissedBanners] = useState(new Set());
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const toastTimer = useRef(null);

  const showToast = useCallback((message, kind = '') => {
    clearTimeout(toastTimer.current);
    setToast({ id: Date.now() + Math.random(), message, kind });
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      setAppState(res);
      if (res.authenticated && view === 'login') setView('home');
      if (!res.authenticated) setView('login');
    } catch { /* SW not ready — will retry */ }
  }, [view]);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onAction = useCallback(async (type, payload) => {
    try {
      switch (type) {
        case 'login': {
          setLoginLoading(true);
          setLoginError('');
          const res = await chrome.runtime.sendMessage({ type: 'LOGIN', ...payload });
          if (res.error) throw new Error(res.error);
          await refreshStatus();
          setView('home');
          break;
        }

        case 'logout': {
          await chrome.runtime.sendMessage({ type: 'LOGOUT' });
          setAppState(null);
          setView('login');
          showToast('Signed out', 'ok');
          break;
        }

        case 'connectAccount': {
          const granted = await chrome.permissions.request({ origins: ['https://fleetedge.home.tatamotors/*'] });
          if (!granted) { showToast('Permission denied — allow access to the fleet portal', 'err'); break; }
          showToast('Connecting to FleetEdge…');
          const res = await chrome.runtime.sendMessage({ type: 'CONNECT_FLEETEDGE' });
          if (res.success) {
            showToast(`Connected ✓ (${res.vehicleCount ?? 0} vehicles)`, 'ok');
            await refreshStatus();
          } else {
            showToast(res.error || 'Connection failed', 'err');
          }
          break;
        }

        case 'reconnectAccount': {
          const { accountId } = payload;
          const granted = await chrome.permissions.request({ origins: ['https://fleetedge.home.tatamotors/*'] });
          if (!granted) { showToast('Permission denied', 'err'); break; }
          showToast('Reconnecting…');
          const res = await chrome.runtime.sendMessage({ type: 'RECONNECT_ACCOUNT', accountId });
          if (res.success) {
            showToast('Reconnected ✓', 'ok');
            setDismissedBanners((prev) => { const s = new Set(prev); s.delete(accountId); return s; });
            await refreshStatus();
          } else {
            showToast(res.error || 'Reconnect failed', 'err');
          }
          break;
        }

        case 'disconnectAccount': {
          const { accountId } = payload;
          const res = await chrome.runtime.sendMessage({ type: 'DISCONNECT_ACCOUNT', accountId });
          if (res.success) { showToast('Account disconnected', 'ok'); await refreshStatus(); }
          else showToast(res.error || 'Disconnect failed', 'err');
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
              await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
              setAppState(null);
              setView('login');
              showToast('All data cleared', 'ok');
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
  }, [refreshStatus, showToast]);

  // ── loading splash ───────────────────────────────────────────────────────
  if (appState === null) {
    return (
      <div className="gnb-popup" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ color: 'var(--fg-3)', fontFamily: 'var(--mono)', fontSize: 11 }}>loading…</span>
      </div>
    );
  }

  // ── login view ───────────────────────────────────────────────────────────
  if (!appState.authenticated || view === 'login') {
    return (
      <div className="gnb-popup">
        <LoginView onAction={onAction} loading={loginLoading} error={loginError} />
        <Toast toast={toast} />
      </div>
    );
  }

  // ── logs view ────────────────────────────────────────────────────────────
  if (view === 'logs') {
    return (
      <div className="gnb-popup" style={{ display: 'flex', flexDirection: 'column' }}>
        <LogsView logs={logs} onAction={onAction} />
        <Toast toast={toast} />
        {confirming && (
          <ConfirmModal
            {...confirming}
            onConfirm={() => { confirming.run?.(); setConfirming(null); }}
            onCancel={() => setConfirming(null)}
          />
        )}
      </div>
    );
  }

  // ── home view ────────────────────────────────────────────────────────────
  const fe = appState.fleetEdge || { accounts: [], pull: {} };
  const accounts = fe.accounts || [];
  const hasActive = accounts.some((a) => deriveStatus(a, Date.now()) === 'linked');
  const expiredAcc = accounts.find(
    (a) => !dismissedBanners.has(a.accountId) &&
      (deriveStatus(a, Date.now()) === 'expired' || deriveStatus(a, Date.now()) === 'expiring')
  );

  return (
    <div className="gnb-popup">
      {/* titlebar */}
      <div className="gnb-titlebar">
        <div className="gnb-brand">
          <svg className="gnb-logo" viewBox="0 0 24 24" width="22" height="22" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="14" height="14" rx="2"/><path d="M16 8l4 2v6h-4"/><circle cx="6" cy="18" r="2"/><circle cx="16" cy="18" r="2"/></svg>
          <div><div className="gnb-brand-name">gnbedge</div></div>
          <span className="gnb-brand-version">v 0.0.0.3</span>
        </div>
        <div className="gnb-userbar">
          <div className="gnb-avatar">{(appState.user?.name || 'U').trim().charAt(0).toUpperCase()}</div>
          <div className="gnb-user-meta">
            <span className="gnb-user-name">{appState.user?.name || 'User'}</span>
            <span className="gnb-role-chip">{appState.user?.role || 'USER'}</span>
          </div>
          <button className="gnb-icon-btn" title="Sign out" onClick={() => onAction('logout')}>
            <Icon.Logout />
          </button>
        </div>
      </div>

      {/* body */}
      <div className="gnb-body">
        {expiredAcc && (
          <ExpiredBanner
            account={expiredAcc}
            onAction={onAction}
            onDismiss={() => onAction('dismissBanner', { accountId: expiredAcc.accountId })}
          />
        )}

        <ConnectivitySummary accounts={accounts} pull={fe.pull || {}} />

        {accounts.length === 0 ? (
          <EmptyAccounts onAction={onAction} />
        ) : (
          <>
            <div className="gnb-section-label">
              Accounts <span className="gnb-section-count">{accounts.length}</span>
            </div>
            {accounts.map((a) => (
              <AccountCard key={a.accountId} account={a} onAction={onAction} />
            ))}
            <div className="gnb-action-row" style={{ marginTop: 4 }}>
              <button className="gnb-btn primary" onClick={() => onAction('connectAccount')}>
                <Icon.Plus /> Connect another
              </button>
              <div className="gnb-tip-wrap" style={{ flex: 1, display: 'flex' }} data-tip={hasActive ? '' : 'No active account'}>
                <button
                  className="gnb-btn secondary"
                  style={{ flex: 1 }}
                  disabled={!hasActive || fe.pull?.pullingNow}
                  onClick={() => onAction('pullNow')}
                >
                  <Icon.Play /> {fe.pull?.pullingNow ? 'Pulling…' : 'Pull from FleetEdge now'}
                </button>
              </div>
            </div>
          </>
        )}

        <div className="gnb-section-label" style={{ marginTop: 4 }}>Tasks</div>
        <MetricsGrid metrics={appState.metrics} />
      </div>

      {/* footer */}
      <div className="gnb-footer">
        <button onClick={() => onAction('viewLogs')}><Icon.Logs /> View logs</button>
        <button className="danger" onClick={() => onAction('clearData')}><Icon.Trash /> Clear data</button>
      </div>

      <Toast toast={toast} />
      {confirming && (
        <ConfirmModal
          {...confirming}
          onConfirm={() => { confirming.run?.(); setConfirming(null); }}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
