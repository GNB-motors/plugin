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
function LoginView({ onLogin, backendUrl, onSetBackendUrl }) {
  const [emailOrMobile, setEmailOrMobile] = useState('');
  const [password, setPassword] = useState('');
  const [urlInput, setUrlInput] = useState(backendUrl || '');
  const [showUrl, setShowUrl] = useState(false);
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

  const handleSaveUrl = useCallback(async () => {
    if (!urlInput.trim()) return;
    try {
      await chrome.runtime.sendMessage({ type: 'SET_BACKEND_URL', url: urlInput.trim() });
      onSetBackendUrl(urlInput.trim());
    } catch (err) {
      setError(err.message);
    }
  }, [urlInput, onSetBackendUrl]);

  return (
    <div className="popup login-view">
      <div className="login-header">
        <h1>FleetEdge Monitor</h1>
        <p className="login-subtitle">Sign in to connect</p>
      </div>

      <form className="login-form" onSubmit={handleSubmit}>
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

      <div className="url-toggle">
        <button onClick={() => setShowUrl((s) => !s)} className="btn-link">
          {showUrl ? 'Hide' : 'Configure'} Backend URL
        </button>
      </div>

      {showUrl && (
        <div className="url-config">
          <div className="input-row">
            <input
              type="text"
              placeholder="https://api.example.com"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
            />
            <button onClick={handleSaveUrl}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main Popup ──────────────────────────────────────────────────────────────
function Popup() {
  const [status, setStatus] = useState(null);
  const [backendUrl, setBackendUrl] = useState('');
  const [showLogs, setShowLogs] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
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
      if (res.backendUrl) setBackendUrl(res.backendUrl);
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

  const handleSaveUrl = useCallback(async () => {
    if (!backendUrl.trim()) return;
    try {
      await chrome.runtime.sendMessage({ type: 'SET_BACKEND_URL', url: backendUrl.trim() });
      flash('Backend URL saved \u2713');
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [backendUrl, flash, refreshStatus]);

  /* ---------- Render ---------- */

  if (loading && !status) {
    return <div className="popup"><p className="loading">Loading...</p></div>;
  }

  // Show login screen if not authenticated
  if (!status?.authenticated) {
    return (
      <LoginView
        backendUrl={backendUrl}
        onLogin={() => refreshStatus()}
        onSetBackendUrl={(url) => { setBackendUrl(url); flash('Backend URL saved \u2713'); }}
      />
    );
  }

  if (showLogs) {
    return (
      <div className="popup logs-view">
        <div className="logs-header">
          <h1>Logs ({logs.length})</h1>
          <button onClick={() => setShowLogs(false)} className="btn-back">&larr; Back</button>
        </div>
        <div className="logs-actions">
          <button onClick={handleViewLogs} className="btn-refresh">Refresh</button>
          <button onClick={handleClearLogs} className="btn-danger">Clear</button>
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
    <div className="popup">
      <div className="header">
        <h1>FleetEdge Monitor</h1>
        <div className="header-actions">
          <button onClick={() => setShowSettings(s => !s)} className="btn-settings" title="Settings">
            &#9881;
          </button>
        </div>
      </div>

      {/* User info bar */}
      <div className="user-bar">
        <span className="user-name">{user?.name || 'User'}</span>
        <span className="user-role">{user?.role || ''}</span>
        <button onClick={handleLogout} className="btn-logout" title="Sign out">
          Sign Out
        </button>
      </div>

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
          <h2>Task Status</h2>
          <div className="metrics-grid">
            <span className="metric-label">Pending</span>
            <span className="metric-value">{bs.pending ?? 0}</span>
            <span className="metric-label">Completed</span>
            <span className="metric-value">{bs.completed ?? 0}</span>
            <span className="metric-label">Failed</span>
            <span className="metric-value error">{bs.failed ?? 0}</span>
            <span className="metric-label">Flagged</span>
            <span className="metric-value warning">{bs.flagged ?? 0}</span>
            <span className="metric-label">Last sync</span>
            <span className="metric-value">{formatRelativeTime(bs.lastSyncAt)}</span>
          </div>
          {bs.isUpToDate && (
            <p className="detail" style={{ color: '#22c55e', marginTop: '4px' }}>&#10003; All tasks processed</p>
          )}
        </section>
      )}

      {showSettings && (
        <section className="settings-section">
          <h2>Settings</h2>
          <div className="input-group">
            <label>Backend URL</label>
            <div className="input-row">
              <input
                type="text"
                placeholder="https://api.example.com"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
              />
              <button onClick={handleSaveUrl}>Save</button>
            </div>
          </div>
        </section>
      )}

      <section className="actions">
        <button
          onClick={handleTriggerProcess}
          disabled={fe?.status !== 'linked'}
          className="btn-primary"
        >
          &#9654; Process Tasks Now
        </button>
        <button onClick={handleViewLogs} className="btn-secondary">
          &#128203; View Logs
        </button>
        <button onClick={handleClearAll} className="btn-danger">
          &#10007; Clear All Data
        </button>
      </section>

      {actionMsg && <p className="action-msg">{actionMsg}</p>}
    </div>
  );
}

export default Popup;
