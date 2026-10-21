import { useState, useEffect, useCallback } from 'react';
import {
  ialertBadge,
  ialertAccountName,
  ialertPlanNote,
  describeIalertProblem,
  describeConnectResult,
} from './ialertModel.js';
import { IconPlus, IconRefresh, Pill, RowMenu } from './ui.jsx';
import { ago } from './time.js';

const count = (n) => Number(n || 0).toLocaleString('en-IN');
const plural = (n, one, many) => `${count(n)} ${n === 1 ? one : many}`;

function IalertAccountRow({ account, onUnlink, style }) {
  const badge = ialertBadge(account);
  const name = ialertAccountName(account);
  const data = ago(account.lastDataAt);
  const note = ialertPlanNote(account.plan);
  const syncFailed = Boolean(account.lastErrorMessage);
  return (
    <div className="acc" style={style}>
      <div className="acc-main">
        <div className="acc-name">{name}</div>
        <div className="acc-meta">
          {plural(account.vehicleCount ?? 0, 'vehicle', 'vehicles')}
          {data ? ` · data ${data}` : ' · waiting for first data'}
        </div>
        {syncFailed ? (
          <div className="acc-note acc-note--crit">
            The last sync failed. If it keeps failing, sign in to iALERT again.
          </div>
        ) : note ? (
          <div className={`acc-note acc-note--${note.tone}`}>{note.text}</div>
        ) : null}
      </div>
      <div className="acc-side">
        <Pill tone={badge.tone}>{badge.label}</Pill>
        <RowMenu
          label={`Options for ${name}`}
          items={[
            { label: 'Disconnect', danger: true, onSelect: () => onUnlink(account.accountId) },
          ]}
        />
      </div>
    </div>
  );
}

/**
 * The Ashok Leyland iALERT card. Linking happens on iALERT's own site: the
 * extension picks up the session when the user signs in there.
 *
 * @param {{ showToast: (msg: string, kind?: string) => void,
 *           confirm: (opts: { title: string, body: string, confirmLabel: string,
 *                             danger: boolean, run: () => Promise<void> }) => void }} props
 */
export default function IalertSection({ showToast, confirm, style }) {
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState([]);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  // Add busy class when loading and accounts exist (syncing)
  const isBusy = loading && accounts.length > 0;

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IALERT_STATUS' });
      if (res) {
        setAccounts(res.accounts || []);
        if (res.error) setError(describeIalertProblem(res.errorStatus, res.error));
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

  const handleConnect = async () => {
    setConnecting(true);
    try {
      const res = await chrome.runtime.sendMessage({ type: 'IALERT_ENABLE' });
      const { text, kind } = describeConnectResult(res);
      showToast(text, kind);
      if (res?.state === 'LINKED') await refreshStatus();
    } catch (err) {
      showToast(err.message || 'Could not connect iALERT', 'err');
    } finally {
      setConnecting(false);
    }
  };

  // Unlink by the GNB accountId (24-hex) — the backend route's key.
  const doUnlink = useCallback(
    async (accountId) => {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'IALERT_UNLINK', accountId });
        if (res?.success) {
          showToast('iALERT account disconnected', 'ok');
          await refreshStatus();
        } else {
          showToast(res?.error || 'Could not disconnect', 'err');
        }
      } catch (err) {
        showToast(err.message || 'Could not disconnect', 'err');
      }
    },
    [refreshStatus, showToast]
  );

  const handleUnlink = (accountId) =>
    confirm({
      title: 'Disconnect this iALERT account?',
      body: 'GNB stops receiving its vehicles. You can connect it again at any time.',
      confirmLabel: 'Disconnect',
      danger: true,
      run: () => doUnlink(accountId),
    });

  const vehicles = accounts.reduce((n, a) => n + (a.vehicleCount ?? 0), 0);
  let sub = 'Not connected';
  if (loading && accounts.length === 0) sub = 'Checking…';
  else if (error && accounts.length === 0) sub = 'Status unavailable';
  else if (accounts.length) {
    sub = `${plural(accounts.length, 'account', 'accounts')} · ${plural(vehicles, 'vehicle', 'vehicles')}`;
  }

  let body;
  if (loading && accounts.length === 0 && !error) {
    body = (
      <div className="skel" aria-hidden="true">
        <span />
        <span />
      </div>
    );
  } else if (error) {
    body = (
      <div className="inline-alert" role="alert">
        <p>{error}</p>
        <button type="button" className="btn btn--sm btn--secondary" onClick={refreshStatus}>
          <IconRefresh /> Retry
        </button>
      </div>
    );
  } else if (accounts.length === 0) {
    body = (
      <div className="prov-empty">
        <ol className="prov-steps">
          <li>Press Connect iALERT.</li>
          <li>Sign in to iALERT.</li>
          <li>iALERT confirms with a green note.</li>
        </ol>
        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={handleConnect}
          disabled={connecting}
        >
          {connecting ? 'Connecting…' : 'Connect iALERT'}
        </button>
        <p className="prov-hint">
          Signed in already? Connect uses that tab for 10 minutes after sign-in.
        </p>
      </div>
    );
  } else {
    body = (
      <>
        <div className="prov-rows">
          {accounts.map((account, i) => (
            <IalertAccountRow
              key={account.tokenDocId || account.accountId}
              account={account}
              onUnlink={handleUnlink}
              style={{ '--i': i }}
            />
          ))}
        </div>
        <footer className="prov-foot">
          <span className="prov-foot-note">Vehicles update every few minutes.</span>
          <button
            type="button"
            className="btn btn--sm btn--secondary"
            onClick={refreshStatus}
            disabled={loading}
          >
            <IconRefresh className={loading ? 'spin' : ''} /> Refresh
          </button>
        </footer>
      </>
    );
  }

  return (
    <section
      className={`prov${isBusy ? ' prov--busy' : ''}`}
      aria-labelledby="prov-ia"
      aria-busy={loading}
      style={style}
    >
      <header className="prov-head">
        <span className="prov-logo prov-logo--al" aria-hidden="true">
          AL
        </span>
        <div className="prov-title">
          <div className="prov-name" id="prov-ia">
            Ashok Leyland iALERT
          </div>
          <div className="prov-sub">{sub}</div>
        </div>
        {accounts.length > 0 && !error && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={handleConnect}
            disabled={connecting}
          >
            <IconPlus /> Add
          </button>
        )}
      </header>
      {body}
    </section>
  );
}
