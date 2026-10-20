import { useState, useEffect, useCallback } from 'react';
import {
  mapStatusToChip,
  getChipLabel,
  formatExpiresAt,
  getAccountLabel,
  describeIalertProblem,
} from './ialertModel.js';

// Icons
const Icon = {
  Plus: (p) => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  Trash: (p) => (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  ),
  Refresh: (p) => (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" {...p}>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <polyline points="21 4 21 10 15 10" />
    </svg>
  ),
};

function StatusChip({ kind, children }) {
  return (
    <span className={`gnb-chip ${kind}`}>
      <span className="dot" />
      {children}
    </span>
  );
}

function IalertAccountRow({ account, onUnlink }) {
  const chipVariant = mapStatusToChip(account.status);
  const label = getAccountLabel(account);
  const expires = formatExpiresAt(account.expiresAt);
  const vehicleCount = account.vehicleCount ?? 0;

  return (
    <div className="gnb-card">
      <div className="gnb-card-top">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="gnb-card-name">{label}</div>
          <div className="gnb-fleetid">{account.externalAccountId}</div>
        </div>
      </div>
      <div className="gnb-card-row2">
        <StatusChip kind={chipVariant}>{getChipLabel(account.status)}</StatusChip>
        {expires !== '—' && <span className="expires">Expires {expires}</span>}
        <span className="count">{vehicleCount} vehicles</span>
      </div>
      <div className="gnb-card-row3">
        <button className="unlink-btn danger" onClick={() => onUnlink(account.accountId)}>
          <Icon.Trash /> Unlink
        </button>
      </div>
    </div>
  );
}

/**
 * @param {{ showToast: (msg: string, kind?: string) => void,
 *           confirm: (opts: { title: string, body: string, confirmLabel: string,
 *                             danger: boolean, run: () => Promise<void> }) => void }} props
 */
export default function IalertSection({ showToast, confirm }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  // Fetch iALERT status
  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IALERT_STATUS' });
      if (res) {
        setAccounts(res.accounts || []);
        if (res.error) {
          setError(describeIalertProblem(res.errorStatus, res.error));
        }
      }
    } catch (err) {
      setError(describeIalertProblem(null, err.message));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Handle Connect button
  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IALERT_ENABLE' });
      if (res?.success) {
        showToast('Sign in to iALERT in the tab that just opened — GNB connects automatically.', 'ok');
        await refreshStatus();
      } else {
        showToast(res?.error || 'Could not open iALERT', 'err');
      }
    } catch (err) {
      showToast(err.message || 'Could not open iALERT', 'err');
    } finally {
      setConnecting(false);
    }
  };

  // Unlink by the GNB accountId (24-hex) — the backend route's key.
  const doUnlink = useCallback(async (accountId) => {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IALERT_UNLINK', accountId });
      if (res?.success) {
        showToast('iALERT account unlinked', 'ok');
        await refreshStatus();
      } else {
        showToast(res?.error || 'Failed to unlink', 'err');
      }
    } catch (err) {
      showToast(err.message || 'Failed to unlink', 'err');
    }
  }, [refreshStatus, showToast]);

  const handleUnlink = (accountId) =>
    confirm({
      title: 'Unlink iALERT account?',
      body: 'This disconnects the iALERT account from GNB. You can reconnect anytime.',
      confirmLabel: 'Unlink',
      danger: true,
      run: () => doUnlink(accountId),
    });

  const card = {
    border: '1px solid var(--line-2)',
    borderRadius: 'var(--radius)',
    background: 'var(--bg-1)',
    padding: 12,
    marginTop: 8,
  };
  const note = { color: 'var(--fg-2)', fontSize: 12, lineHeight: 1.45, margin: '0 0 10px' };

  if (loading) {
    return (
      <>
        <div className="gnb-section-label" style={{ marginTop: 16 }}>iALERT</div>
        <div style={card}>
          <p style={{ ...note, margin: 0 }}>Checking your iALERT connection…</p>
        </div>
      </>
    );
  }

  // A problem is shown IN the card, in plain words, with a way out.
  if (error) {
    return (
      <>
        <div className="gnb-section-label" style={{ marginTop: 16 }}>iALERT</div>
        <div
          role="alert"
          style={{ ...card, borderColor: 'var(--red)', background: 'var(--red-soft)' }}
        >
          <p style={{ ...note, color: 'var(--red-2)', fontWeight: 600 }}>{error}</p>
          <button className="gnb-btn secondary" onClick={refreshStatus}>
            <Icon.Refresh /> Retry
          </button>
        </div>
      </>
    );
  }

  if (accounts.length === 0) {
    return (
      <>
        <div className="gnb-section-label" style={{ marginTop: 16 }}>iALERT</div>
        <div style={card}>
          <p style={{ ...note, color: 'var(--fg-0)', fontWeight: 600 }}>Not connected</p>
          <p style={note}>
            1. Click Connect — iALERT opens in a new tab.
            <br />
            2. Sign in there. GNB connects by itself within a few seconds.
          </p>
          <button className="gnb-btn primary full" onClick={handleConnect} disabled={connecting}>
            <Icon.Plus /> {connecting ? 'Opening iALERT…' : 'Connect iALERT'}
          </button>
        </div>
      </>
    );
  }

  // Show accounts
  return (
    <>
      <div className="gnb-section-label" style={{ marginTop: 16 }}>
        iALERT <span className="gnb-section-count">{accounts.length}</span>
      </div>
      {accounts.map((account) => (
        <IalertAccountRow
          key={account.tokenDocId || account.accountId}
          account={account}
          onUnlink={handleUnlink}
        />
      ))}
      <div className="gnb-action-row" style={{ marginTop: 4 }}>
        <button className="gnb-btn secondary" onClick={refreshStatus}>
          <Icon.Refresh /> Refresh
        </button>
      </div>
    </>
  );
}
