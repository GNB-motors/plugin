import { useState, useEffect, useCallback, useRef } from 'react';
import './Popup.css';

const AUTO_REFRESH_MS = 30_000;

function formatRelativeTime(isoOrMs) {
  if (!isoOrMs) return 'never';
  const ms = typeof isoOrMs === 'number' ? isoOrMs : new Date(isoOrMs).getTime();
  const diff = Math.round((Date.now() - ms) / 1000);
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}

// ─── Login Screen ────────────────────────────────────────────────────────────
function LoginView({ onLogin }) {
  const [emailOrMobile, setEmailOrMobile] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!emailOrMobile.trim() || !password.trim()) return;
    setLoading(true);
    setError('');
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'LOGIN',
        emailOrMobile: emailOrMobile.trim(),
        password: password.trim(),
      });
      if (res.error) throw new Error(res.error);
      onLogin(res.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [emailOrMobile, password, onLogin]);

  return (
    <div className="popup login-view fade-in">
      <div className="login-header slide-down">
        <div className="login-logo">
          <svg viewBox="0 0 24 24" width="32" height="32" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="14" height="14" rx="2"></rect><path d="M16 8l4 2v6h-4"></path><circle cx="6" cy="18" r="2"></circle><circle cx="16" cy="18" r="2"></circle></svg>
        </div>
        <h1>FleetEdge Monitor</h1>
        <p className="login-subtitle">Secure connection to your fleet data</p>
      </div>

      <form className="login-form slide-up" onSubmit={handleSubmit}>
        <div className="input-group">
          <label>Email or Mobile</label>
          <input
            type="text"
            value={emailOrMobile}
            onChange={(e) => setEmailOrMobile(e.target.value)}
            placeholder="Enter email or mobile number"
            autoFocus
          />
        </div>

        <div className="input-group">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
            onKeyDown={(e) => e.key === 'Enter' && handleSubmit(e)}
          />
        </div>

        {error && <p className="login-error">{error}</p>}

        <button
          type="submit"
          className="btn-login"
          disabled={loading || !emailOrMobile.trim() || !password.trim()}
        >
          {loading ? 'Signing in...' : 'Sign In'}
        </button>
      </form>

    </div>
  );
}

// ─── Main Popup ──────────────────────────────────────────────────────────────
function Popup() {
  const [status, setStatus] = useState(null);
  const [showLogs, setShowLogs] = useState(false);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');
  const [connecting, setConnecting] = useState(false);
  const msgTimer = useRef(null);

  const flash = useCallback((msg, duration = 3000) => {
    clearTimeout(msgTimer.current);
    setActionMsg(msg);
    msgTimer.current = setTimeout(() => setActionMsg(''), duration);
  }, []);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
      setStatus(res);
    } catch (err) {
      console.error('Failed to get status:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const handleLogout = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'LOGOUT' });
      flash('Logged out');
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [flash, refreshStatus]);

  const handleConnectFleetEdge = useCallback(async () => {
    setConnecting(true);
    flash('Connecting to FleetEdge...');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'CONNECT_FLEETEDGE' });
      if (res.success) {
        flash(`FleetEdge connected \u2713 (${res.vehicleCount} vehicles)`);
      } else {
        flash(res.error || 'Connection failed');
      }
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    } finally {
      setConnecting(false);
    }
  }, [flash, refreshStatus]);

  const handleDisconnectFleetEdge = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'DISCONNECT_FLEETEDGE' });
      flash('FleetEdge disconnected');
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [flash, refreshStatus]);

  const handleTriggerProcess = useCallback(async () => {
    flash('Processing tasks...');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'TRIGGER_PROCESS' });
      if (res.success) {
        const r = res.result;
        flash(`Done: ${r.processed} processed, ${r.failed} failed`);
      } else {
        flash(res.error || 'Processing failed');
      }
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [flash, refreshStatus]);

  const handleViewLogs = useCallback(async () => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'GET_LOGS', limit: 100 });
      setLogs(res.logs || []);
      setShowLogs(true);
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [flash]);

  const handleClearLogs = useCallback(async () => {
    if (!confirm('Clear all logs?')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_LOGS' });
    setLogs([]);
    flash('Logs cleared');
  }, [flash]);

  const handleClearAll = useCallback(async () => {
    if (!confirm('Clear all stored data and disconnect FleetEdge?')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
    flash('All data cleared');
    refreshStatus();
  }, [flash, refreshStatus]);

  /* ---------- Render ---------- */

  if (loading && !status) {
    return <div className="popup glass-container centered"><span className="loader"></span></div>;
  }

  // Show login screen if not authenticated
  if (!status?.authenticated) {
    return (
      <LoginView
        onLogin={() => refreshStatus()}
      />
    );
  }

  if (showLogs) {
    return (
      <div className="popup logs-view glass-container slide-left">
        <div className="logs-header">
          <h1>System Logs</h1>
          <span className="log-count">{logs.length} entries</span>
          <button onClick={() => setShowLogs(false)} className="btn-back">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
            Back
          </button>
        </div>
        <div className="logs-actions">
          <button onClick={handleViewLogs} className="btn-refresh glass-btn">Refresh</button>
          <button onClick={handleClearLogs} className="btn-danger glass-btn">Clear logs</button>
        </div>
        <div className="logs-container">
          {logs.length === 0 ? (
            <p className="no-logs">No logs yet</p>
          ) : (
            logs.slice().reverse().map((log, idx) => (
              <div key={idx} className={`log-entry log-${log.level.toLowerCase()}`}>
                <span className="log-time">
                  {new Date(log.timestamp).toLocaleTimeString()}
                </span>
                <span className="log-level">{log.level}</span>
                <span className="log-module">{log.module}</span>
                <div className="log-message">{log.message}</div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  const fe = status?.fleetEdge;
  const bs = status?.backendStatus;
  const user = status?.user;

  return (
    <div className="popup glass-container fade-in">
      <div className="header glow-border-bottom">
        <div className="header-brand">
          <div className="logo-mark"><svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="14" height="14" rx="2"></rect><path d="M16 8l4 2v6h-4"></path><circle cx="6" cy="18" r="2"></circle><circle cx="16" cy="18" r="2"></circle></svg></div>
          <h1>FleetEdge Monitor</h1>
        </div>
      </div>

      {/* User info bar */}
      <div className="user-bar glass-panel">
        <div className="user-info">
          <div className="user-avatar">{user?.name ? user.name.charAt(0).toUpperCase() : 'U'}</div>
          <div>
            <span className="user-name">{user?.name || 'User'}</span>
            <span className="user-role">{user?.role || ''}</span>
          </div>
        </div>
        <button onClick={handleLogout} className="btn-logout" title="Sign out">
          Sign Out
        </button>
      </div>

      {/* View Wrapper for animations */}
      <div className="main-content-flow slide-up">
        {/* FleetEdge Connection */}
        <section className="status-section">
          <h2>FleetEdge Connection</h2>
        {fe?.status === 'linked' ? (
          <>
            <div className="status-badge valid">
              &#10003; Connected &mdash; {Math.floor((fe.remainingSeconds || 0) / 60)}m remaining
            </div>
            {fe.fleetId && <p className="detail">Fleet: {fe.fleetId}</p>}
            {fe.vehicleCount > 0 && <p className="detail">{fe.vehicleCount} vehicles</p>}
            <button onClick={handleDisconnectFleetEdge} className="btn-danger btn-sm">
              Disconnect
            </button>
          </>
        ) : fe?.status === 'expired' ? (
          <>
            <div className="status-badge expired">
              &#10007; Session expired &mdash; please re-connect
            </div>
            <p className="detail hint">
              1. Open FleetEdge and log in<br/>
              2. Click &quot;Connect FleetEdge&quot; below
            </p>
            <button
              onClick={handleConnectFleetEdge}
              disabled={connecting}
              className="btn-primary"
            >
              {connecting ? 'Connecting...' : '\u{1F517} Re-connect FleetEdge'}
            </button>
          </>
        ) : (
          <>
            <div className="status-badge inactive">
              Not connected &mdash; link your FleetEdge session
            </div>
            <p className="detail hint">
              1. Open <strong>fleetedge.home.tatamotors</strong> and log in<br/>
              2. Click &quot;Connect FleetEdge&quot; below
            </p>
            <button
              onClick={handleConnectFleetEdge}
              disabled={connecting}
              className="btn-primary"
            >
              {connecting ? 'Connecting...' : '\u{1F517} Connect FleetEdge'}
            </button>
          </>
        )}
      </section>

      {/* Backend Task Status */}
      {bs && (
        <section className="status-section">
          <h2>Task Status Overview</h2>
          <div className="metrics-grid glass-panel">
            <div className="metric-box">
              <span className="metric-label">Pending</span>
              <span className="metric-value pending-val">{bs.pending ?? 0}</span>
            </div>
            <div className="metric-box">
              <span className="metric-label">Completed</span>
              <span className="metric-value success-val">{bs.completed ?? 0}</span>
            </div>
            <div className="metric-box">
              <span className="metric-label">Failed</span>
              <span className="metric-value error-val">{bs.failed ?? 0}</span>
            </div>
            <div className="metric-box">
              <span className="metric-label">Flagged</span>
              <span className="metric-value warning-val">{bs.flagged ?? 0}</span>
            </div>
          </div>
          <div className="sync-footer">
            <div className="sync-time">
              <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"></circle><polyline points="12 6 12 12 16 14"></polyline></svg>
              <span>{formatRelativeTime(bs.lastSyncAt)}</span>
            </div>
            {bs.isUpToDate && (
              <span className="sync-status-ok">
                <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>
                All tasks processed
              </span>
            )}
          </div>
        </section>
      )}

      <section className="actions">
        <button
          onClick={handleTriggerProcess}
          disabled={fe?.status !== 'linked'}
          className="btn-primary btn-process"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3l14 9-14 9V3z"></path></svg>
          Process Tasks Now
        </button>
        <div className="action-row">
          <button onClick={handleViewLogs} className="btn-secondary">
            View Logs
          </button>
          <button onClick={handleClearAll} className="btn-danger">
            Clear Data
          </button>
        </div>
      </section>

      {actionMsg && <div className="action-msg-toast slide-up">{actionMsg}</div>}
      
      </div> {/* End view wrapper */}
    </div>
  );
}

export default Popup;
