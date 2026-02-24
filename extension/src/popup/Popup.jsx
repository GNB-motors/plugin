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

// ─── Manual Query view ───────────────────────────────────────────────────────
function ManualQueryView({ onBack }) {
  const [identifier, setIdentifier] = useState('');
  const [fromDate, setFromDate]     = useState('');
  const [fromTime, setFromTime]     = useState('');
  const [toDate, setToDate]         = useState('');
  const [toTime, setToTime]         = useState('');
  const [fetching, setFetching]     = useState(false);
  const [result, setResult]         = useState(null);
  const [error, setError]           = useState('');
  const [copied, setCopied]         = useState(false);

  // Load any previously saved result on mount
  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_MANUAL_RESULT' })
      .then(res => { if (res.result) setResult(res.result); })
      .catch(() => {});
  }, []);

  const handleFetch = useCallback(async () => {
    if (!identifier.trim()) return;
    setFetching(true);
    setError('');
    setResult(null);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'MANUAL_FETCH',
        identifier: identifier.trim(),
        fromDate, fromTime,
        toDate,   toTime,
      });
      if (res.error) throw new Error(res.error);
      setResult({ ...res, fetchedAt: new Date().toISOString() });
    } catch (err) {
      setError(err.message);
    } finally {
      setFetching(false);
    }
  }, [identifier, fromDate, fromTime, toDate, toTime]);

  const handleCopy = useCallback(() => {
    if (!result?.data) return;
    navigator.clipboard.writeText(JSON.stringify(result.data, null, 2))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  }, [result]);

  const records = result?.data?.results || [];

  return (
    <div className="popup query-view">
      <div className="logs-header">
        <h1>Manual Query</h1>
        <button onClick={onBack} className="btn-back">&larr; Back</button>
      </div>

      <div className="query-form">
        <div className="input-group">
          <label>Registration or VIN / Chassis</label>
          <input
            type="text"
            value={identifier}
            onChange={e => setIdentifier(e.target.value)}
            placeholder="e.g. WB25R9640 or MAT828113S2C05629"
          />
        </div>

        <div className="query-row">
          <div className="input-group half">
            <label>From date (IST)</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} />
          </div>
          <div className="input-group half">
            <label>From time (IST)</label>
            <input type="time" value={fromTime} onChange={e => setFromTime(e.target.value)} />
          </div>
        </div>

        <div className="query-row">
          <div className="input-group half">
            <label>To date (IST)</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} />
          </div>
          <div className="input-group half">
            <label>To time (IST)</label>
            <input type="time" value={toTime} onChange={e => setToTime(e.target.value)} />
          </div>
        </div>

        <button
          className="btn-primary query-btn"
          onClick={handleFetch}
          disabled={fetching || !identifier.trim()}
        >
          {fetching ? 'Fetching…' : '&#9654; Fetch Fuel Data'}
        </button>
      </div>

      {error && <p className="query-error">{error}</p>}

      {result && !error && (
        <div className="query-result">
          <div className="result-header">
            <span>
              VIN: <strong>{result.vin}</strong>
              {result.registration && <> &mdash; Reg: <strong>{result.registration}</strong></>}
            </span>
            <span className="result-count">{records.length} record{records.length !== 1 ? 's' : ''}</span>
          </div>
          <p className="result-meta">
            {result.fromIst || `${fromDate} ${fromTime}`}
            &nbsp;&rarr;&nbsp;
            {result.toIst || `${toDate} ${toTime}`} (IST)
          </p>
          <p className="result-meta saved-note">&#10003; Saved to extension storage</p>
          {result.relay && (
            <p className={`relay-badge ${result.relay.relayed ? 'relayed' : 'local'}`}>
              {result.relay.relayed
                ? '&#8593; Relayed to backend ✓'
                : `💾 Local only (${result.relay.reason || 'no_backend'})`}
            </p>
          )}

          {records.length > 0 && (
            <div className="result-table-wrap">
              <table className="result-table">
                <thead>
                  <tr>
                    <th>VIN</th>
                    <th>Fuel (L)</th>
                    <th>Dist (km)</th>
                    <th>Avg spd</th>
                  </tr>
                </thead>
                <tbody>
                  {records.map((r, i) => (
                    <tr key={i}>
                      <td title={r.vin}>{(r.vin || '—').slice(-8)}</td>
                      <td>{r.fuel_used != null ? r.fuel_used.toFixed(1) : '—'}</td>
                      <td>{r.distance  != null ? r.distance.toFixed(1)  : '—'}</td>
                      <td>{r.avg_speed != null ? r.avg_speed.toFixed(1) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <button className="btn-secondary copy-btn" onClick={handleCopy}>
            {copied ? '&#10003; Copied!' : '&#128203; Copy raw JSON'}
          </button>
        </div>
      )}
    </div>
  );
}

function Popup() {
  const [status, setStatus] = useState(null);
  const [systemToken, setSystemToken] = useState('');
  const [backendUrl, setBackendUrl] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [logs, setLogs] = useState([]);
  const [showLogs, setShowLogs] = useState(false);
  const [showQuery, setShowQuery]   = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionMsg, setActionMsg] = useState('');
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

  // Initial fetch + auto-refresh while popup is open
  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [refreshStatus]);

  const handleSaveToken = useCallback(async () => {
    if (!systemToken.trim()) return;
    try {
      await chrome.runtime.sendMessage({ type: 'SET_SYSTEM_TOKEN', token: systemToken.trim() });
      flash('Backend token saved ✓');
      setSystemToken('');
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [systemToken, flash, refreshStatus]);

  const handleSaveBackendUrl = useCallback(async () => {
    if (!backendUrl.trim()) return;
    try {
      await chrome.runtime.sendMessage({ type: 'SET_BACKEND_URL', url: backendUrl.trim() });
      flash('Backend URL saved ✓');
      refreshStatus();
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [backendUrl, flash, refreshStatus]);

  const handleTriggerPoll = useCallback(async () => {
    try {
      await chrome.runtime.sendMessage({ type: 'TRIGGER_POLL' });
      flash('Poll triggered — check logs');
    } catch (err) {
      flash(`Error: ${err.message}`);
    }
  }, [flash]);

  const handleRefreshVehicles = useCallback(async () => {
    flash('Refreshing vehicles...');
    try {
      const res = await chrome.runtime.sendMessage({ type: 'REFRESH_VEHICLES' });
      flash(res.success ? `Loaded ${res.count} vehicles ✓` : 'No valid token');
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
    if (!confirm('Clear all stored data including tokens and cache?')) return;
    await chrome.runtime.sendMessage({ type: 'CLEAR_ALL' });
    flash('All data cleared');
    refreshStatus();
  }, [flash, refreshStatus]);

  /* ---------- Render ---------- */

  if (loading && !status) {
    return <div className="popup"><p className="loading">Loading...</p></div>;
  }

  if (showQuery) {
    return <ManualQueryView onBack={() => setShowQuery(false)} />;
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

  const m = status?.metrics;

  return (
    <div className="popup">
      <div className="header">
        <h1>FleetEdge Monitor</h1>
        <button onClick={() => setShowSettings(s => !s)} className="btn-settings">
          &#9881;
        </button>
      </div>

      <section className="status-section">
        <h2>FleetEdge Token</h2>
        {status?.hasFleetToken ? (
          <div className={`status-badge ${status.tokenValid ? 'valid' : 'expired'}`}>
            {status.tokenValid ? (
              <>&#10003; Active &mdash; {Math.floor(status.remainingSeconds / 60)}m remaining</>
            ) : (
              <>&#10007; Expired &mdash; please log into FleetEdge</>
            )}
          </div>
        ) : (
          <div className="status-badge inactive">
            No token &mdash; open FleetEdge and log in
          </div>
        )}
        {status?.fleetId && (
          <p className="detail">Fleet: {status.fleetId}</p>
        )}
      </section>

      <section className="status-section">
        <h2>Backend Connection</h2>
        {status?.hasSystemToken ? (
          <div className="status-badge valid">&#10003; Token Configured</div>
        ) : (
          <div className="status-badge inactive">&#10007; Not Configured</div>
        )}
        {status?.backendUrl && (
          <p className="detail">{status.backendUrl}</p>
        )}
      </section>

      <section className="status-section">
        <h2>Vehicle Cache</h2>
        {status?.vehicleCount > 0 ? (
          <p className="detail">
            {status.vehicleCount} vehicles
            {status.vinMapAge !== null && ` (${status.vinMapAge}m ago)`}
          </p>
        ) : (
          <p className="detail muted">Not loaded yet</p>
        )}
      </section>

      {m && (m.totalProcessed > 0 || m.totalFailed > 0) && (
        <section className="status-section metrics-section">
          <h2>Runtime Metrics</h2>
          <div className="metrics-grid">
            <span className="metric-label">Processed</span>
            <span className="metric-value">{m.totalProcessed ?? 0}</span>
            <span className="metric-label">Failed</span>
            <span className="metric-value error">{m.totalFailed ?? 0}</span>
            <span className="metric-label">Last poll</span>
            <span className="metric-value">{formatRelativeTime(m.lastPollAt)}</span>
            {m.lastCycleDuration != null && (
              <>
                <span className="metric-label">Cycle time</span>
                <span className="metric-value">{(m.lastCycleDuration / 1000).toFixed(1)}s</span>
              </>
            )}
          </div>
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
                placeholder="https://api.example.com/api"
                value={backendUrl}
                onChange={(e) => setBackendUrl(e.target.value)}
              />
              <button onClick={handleSaveBackendUrl}>Save</button>
            </div>
          </div>

          <div className="input-group">
            <label>Backend Token</label>
            <div className="input-row">
              <input
                type="password"
                placeholder="Enter your backend auth token"
                value={systemToken}
                onChange={(e) => setSystemToken(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSaveToken()}
              />
              <button onClick={handleSaveToken}>Save</button>
            </div>
          </div>
        </section>
      )}

      <section className="actions">
        <button 
          onClick={handleTriggerPoll} 
          disabled={!status?.tokenValid || !status?.hasSystemToken}
          className="btn-primary"
        >
          &#9654; Poll Tasks Now
        </button>
        <button 
          onClick={handleRefreshVehicles} 
          disabled={!status?.tokenValid}
          className="btn-secondary"
        >
          &#8635; Refresh Vehicles
        </button>
        <button onClick={() => setShowQuery(true)} className="btn-secondary">
          &#128269; Manual Query
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
