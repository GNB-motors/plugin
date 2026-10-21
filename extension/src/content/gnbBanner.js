/**
 * GNB Edge in-page banner (content scripts, ISOLATED world).
 * ───────────────────────────────────────────────────────────
 * One small card in the top-right corner of a fleet portal tab that tells the
 * user what GNB Edge is doing there: connecting, connected (you may close the
 * tab), or what to do next. It lives in a closed Shadow DOM so the portal's CSS
 * cannot touch it and the portal's scripts cannot read it.
 *
 * Text is set with textContent only — titles and bodies can carry server error
 * messages, which must never be parsed as HTML. Never pass a token in here.
 */

const HOST_ID = 'gnb-edge-banner';

const TONES = {
  progress: '#1e3a8a',
  ok: '#15803d',
  warn: '#b45309',
  err: '#b91c1c',
};

const CSS = `
:host { all: initial; }
.card {
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  box-sizing: border-box; width: 360px; max-width: calc(100vw - 32px);
  display: grid; grid-template-columns: auto 1fr auto; gap: 4px 12px; align-items: start;
  padding: 14px 14px 14px 16px; border-radius: 12px; background: #fff; color: #0f172a;
  border: 1px solid #e2e8f0; border-left: 4px solid var(--tone);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
  font: 13px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  animation: gnb-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
.mark {
  grid-row: 1 / span 3; width: 22px; height: 22px; margin-top: 1px; border-radius: 50%;
  display: grid; place-items: center; background: var(--tone); color: #fff;
  font-weight: 700; font-size: 13px;
}
.spin {
  box-sizing: border-box; background: transparent; border: 2.5px solid #c7d2fe;
  border-top-color: var(--tone); animation: gnb-spin 800ms linear infinite;
}
.brand { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; color: #64748b; text-transform: uppercase; }
.title { grid-column: 2; font-size: 15px; font-weight: 600; color: #0f172a; }
.body { grid-column: 2; color: #334155; }
.count { grid-column: 2; margin-top: 4px; font-weight: 600; color: var(--tone); }
.close {
  grid-column: 3; grid-row: 1; width: 24px; height: 24px; margin: -4px -4px 0 0; padding: 0;
  border: 0; border-radius: 6px; background: transparent; color: #64748b; cursor: pointer;
  font: 18px/1 system-ui, sans-serif;
}
.close:hover { background: #f1f5f9; color: #0f172a; }
.close:focus-visible { outline: 2px solid var(--tone); outline-offset: 1px; }
@keyframes gnb-in { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: none; } }
@keyframes gnb-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .card { animation: none; }
  .spin { animation: none; border-color: var(--tone); }
}
`;

let current = null; // { host, timers: [] }

function clearTimers() {
  if (!current) return;
  for (const t of current.timers) clearTimeout(t);
  current.timers = [];
}

/** Remove the banner, if one is showing. */
export function hideGnbBanner() {
  if (!current) return;
  clearTimers();
  current.host.remove();
  current = null;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = String(text);
  return node;
}

/**
 * Show (or replace) the banner.
 * @param {{ tone?: 'progress'|'ok'|'warn'|'err', title: string, body?: string,
 *           autoHideMs?: number, closeAfterMs?: number,
 *           onCountdownEnd?: () => void }} opts
 */
export function showGnbBanner(opts) {
  const { title, body, autoHideMs, closeAfterMs, onCountdownEnd } = opts || {};
  const tone = TONES[opts?.tone] ? opts.tone : 'progress';
  hideGnbBanner();

  const host = el('div');
  host.id = HOST_ID;
  const root = host.attachShadow({ mode: 'closed' });
  const style = el('style', null, CSS);
  const card = el('div', 'card');
  card.setAttribute('role', tone === 'err' ? 'alert' : 'status');
  card.setAttribute('aria-live', tone === 'err' ? 'assertive' : 'polite');
  card.style.setProperty('--tone', TONES[tone]);

  const mark = el(
    'span',
    tone === 'progress' ? 'mark spin' : 'mark',
    { ok: '✓', warn: '!', err: '!' }[tone] ?? ''
  );
  mark.setAttribute('aria-hidden', 'true');
  const close = el('button', 'close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close GNB Edge message');
  close.addEventListener('click', () => hideGnbBanner());

  card.append(mark, el('div', 'brand', 'GNB Edge'), close, el('div', 'title', title));
  if (body) card.append(el('div', 'body', body));
  root.append(style, card);
  (document.body || document.documentElement).append(host);

  current = { host, timers: [] };
  const mine = current;

  if (Number.isFinite(closeAfterMs) && closeAfterMs > 0) {
    let left = Math.ceil(closeAfterMs / 1000);
    const count = el('div', 'count', `Closing in ${left} s`);
    card.append(count);
    const tick = () => {
      if (current !== mine) return; // replaced or closed meanwhile
      left -= 1;
      if (left > 0) {
        count.textContent = `Closing in ${left} s`;
        mine.timers.push(setTimeout(tick, 1000));
        return;
      }
      count.textContent = 'Closing…';
      if (typeof onCountdownEnd === 'function') onCountdownEnd();
    };
    mine.timers.push(setTimeout(tick, 1000));
  } else if (Number.isFinite(autoHideMs) && autoHideMs > 0) {
    mine.timers.push(
      setTimeout(() => {
        if (current === mine) hideGnbBanner();
      }, autoHideMs)
    );
  }
}
