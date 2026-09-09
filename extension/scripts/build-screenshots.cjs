#!/usr/bin/env node
/**
 * Regenerates the Chrome Web Store listing assets from the real built popup.
 *
 * The previous assets were hand-written HTML mockups of the popup, and they had
 * drifted: by 0.0.0.4 they showed a dark rounded-square logo, the line "Secure
 * connection to your fleet data", and a grey "Sign In" button — none of which
 * the UI has had for some time. The dashboard shot was clipped mid-header with
 * a scrollbar in frame, and the "promo tile" was that same stale login shot
 * squashed to 440x280.
 *
 * So this renders dist/ itself — the actual React popup, the actual Popup.css —
 * behind a stubbed `chrome` API, then frames it for the store. Rebuild the
 * extension, rerun this, and the assets track the UI instead of drifting.
 *
 * Usage:  npm run build && node scripts/build-screenshots.cjs
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

/** Serves dist/ — the bundle uses absolute /assets/… paths, so file:// won't do. */
function serveDist() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const filePath = path.join(DIST, rel === '/' ? 'index.html' : rel);
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')).version;

/** The one message the popup needs answered to render a signed-in dashboard. */
function dashboardState() {
  const now = Date.now();
  return {
    authenticated: true,
    // Deliberately synthetic. These assets are public on the store listing, so
    // no real operator name and no real fleet id goes in — the old dashboard
    // shot shipped an actual fleet identifier.
    user: { name: 'Demo Owner', role: 'OWNER' },
    backendUrl: 'https://api.app.gnbedge.in/v1',
    fleetEdge: {
      accounts: [
        {
          accountId: 'acc_1',
          friendlyName: 'Northbound Logistics',
          fleetId: 'U10000000000000000000',
          vehicleCount: 157,
          status: 'ACTIVE',
          expiresAt: new Date(now + 19 * 3600 * 1000).toISOString(),
          lastPullAt: new Date(now - 4 * 60 * 1000).toISOString(),
        },
      ],
      pull: {
        lastRunAt: new Date(now - 4 * 60 * 1000).toISOString(),
        nextRunAt: new Date(now + 26 * 60 * 1000).toISOString(),
        pullingNow: false,
      },
    },
    metrics: { pending: 12, inProgress: 0, completed: 1284, flagged: 7, noData: 3 },
    backendStatus: { pending: 12, inProgress: 0, completed: 1284, flagged: 7, noData: 3 },
  };
}

function loginState() {
  return {
    authenticated: false,
    user: null,
    fleetEdge: { accounts: [], pull: {} },
    metrics: {},
  };
}

/**
 * Runs before any bundle code, so React never sees a missing `chrome`.
 * Built as a string because it must be injected via addInitScript.
 */
function chromeStub(state, version) {
  return (
    'const __state = ' +
    JSON.stringify(state) +
    ';\n' +
    'const __version = ' +
    JSON.stringify(version) +
    ';\n' +
    'globalThis.chrome = {\n' +
    '  runtime: {\n' +
    '    getManifest: () => ({ version: __version }),\n' +
    "    sendMessage: async (msg) => (msg && msg.type === 'GET_STATUS' ? __state : null),\n" +
    '    onMessage: { addListener() {}, removeListener() {} },\n' +
    '    lastError: undefined,\n' +
    "    id: 'screenshot',\n" +
    '  },\n' +
    '  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {} } },\n' +
    '  tabs: { query: async () => [], remove: async () => {} },\n' +
    '  permissions: { contains: async () => true, request: async () => true },\n' +
    '  alarms: { create() {}, clear() {} },\n' +
    '  notifications: { create() {} },\n' +
    '};\n'
  );
}

/**
 * Draws the marketing frame around the live popup node.
 * Runs in the page; `copy` is passed as a structured argument.
 */
function applyFrame(copy) {
  const popup = document.querySelector('.gnb-popup');
  if (!popup) throw new Error('popup did not render');

  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const MONO = "ui-monospace,'SF Mono',Menlo,monospace";

  document.body.style.cssText = 'margin:0;width:1280px;height:800px;overflow:hidden';

  const stage = document.createElement('div');
  stage.style.cssText = [
    'position:absolute',
    'inset:0',
    'display:flex',
    'align-items:center',
    'gap:72px',
    'padding:0 84px',
    'box-sizing:border-box',
    'background:radial-gradient(1100px 620px at 78% 42%, #1e3a8a 0%, #111c33 45%, #0b1120 100%)',
    'font-family:' + SANS,
  ].join(';');

  const text = document.createElement('div');
  text.style.cssText = 'flex:1;min-width:0;color:#ffffff';

  const eyebrow = document.createElement('div');
  eyebrow.textContent = copy.eyebrow;
  eyebrow.style.cssText =
    'font-family:' +
    MONO +
    ';font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#60a5fa;margin-bottom:20px';

  const headline = document.createElement('div');
  headline.textContent = copy.headline;
  headline.style.cssText =
    'font-size:44px;line-height:1.14;font-weight:600;letter-spacing:-.025em;color:#f8fafc;margin-bottom:26px';

  const list = document.createElement('ul');
  list.style.cssText =
    'list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:14px';

  for (const line of copy.bullets) {
    const li = document.createElement('li');
    li.style.cssText =
      'display:flex;align-items:flex-start;gap:12px;font-size:16px;line-height:1.45;color:#cbd5e1';

    const tick = document.createElement('span');
    tick.textContent = '✓';
    tick.style.cssText =
      'flex:none;width:18px;height:18px;margin-top:2px;border-radius:50%;background:rgba(59,130,246,.18);' +
      'color:#93c5fd;font-size:11px;display:flex;align-items:center;justify-content:center';

    const label = document.createElement('span');
    label.textContent = line;

    li.appendChild(tick);
    li.appendChild(label);
    list.appendChild(li);
  }

  text.appendChild(eyebrow);
  text.appendChild(headline);
  text.appendChild(list);

  // The popup is 380x560; 1.18 fills the frame while leaving margin in 800px.
  const holder = document.createElement('div');
  holder.style.cssText =
    'flex:none;width:449px;height:661px;filter:drop-shadow(0 30px 60px rgba(2,6,23,.55))';

  stage.appendChild(text);
  stage.appendChild(holder);
  document.body.appendChild(stage);
  holder.appendChild(popup);
  popup.style.transform = 'scale(1.18)';
  popup.style.transformOrigin = 'center';
  popup.style.margin = '50px 34px';
}

/** Promo tile: icon + wordmark on the brand ground, per CWS_SUBMISSION.md. */
function applyTile() {
  const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";
  const MONO = "ui-monospace,'SF Mono',Menlo,monospace";

  document.documentElement.style.cssText = 'margin:0';
  document.body.style.cssText = [
    'margin:0',
    'width:440px',
    'height:280px',
    'display:flex',
    'align-items:center',
    'gap:26px',
    'padding:0 34px',
    'box-sizing:border-box',
    'background:radial-gradient(520px 300px at 72% 30%, #1e3a8a 0%, #111c33 55%, #0b1120 100%)',
    'font-family:' + SANS,
  ].join(';');
  document.body.innerHTML = '';

  const icon = document.createElement('img');
  icon.src = '/icons/icon128.png';
  icon.width = 104;
  icon.height = 104;
  icon.style.cssText = 'flex:none;border-radius:24px';

  const block = document.createElement('div');
  block.style.cssText = 'color:#ffffff;min-width:0';

  const name = document.createElement('div');
  name.textContent = 'gnbedge';
  name.style.cssText = 'font-size:34px;font-weight:600;letter-spacing:-.03em;line-height:1';

  const tagline = document.createElement('div');
  tagline.textContent = 'Fleet · Fuel · Audit';
  tagline.style.cssText =
    'font-family:' +
    MONO +
    ';font-size:10px;letter-spacing:.2em;text-transform:uppercase;color:#60a5fa;margin-top:10px';

  const pitch = document.createElement('div');
  pitch.textContent = 'Fleet fuel audits, automated.';
  pitch.style.cssText =
    'font-size:14px;color:#cbd5e1;margin-top:14px;line-height:1.4;max-width:200px';

  block.appendChild(name);
  block.appendChild(tagline);
  block.appendChild(pitch);
  document.body.appendChild(icon);
  document.body.appendChild(block);
}

const SHOTS = [
  {
    file: 'cws-screenshot-login.png',
    state: loginState(),
    // Typed into the real inputs so React enables the CTA — an empty form
    // renders it disabled and grey, which reads as a broken button in a listing.
    prefill: { email: 'ops@northbound.example', password: 'demo-password' },
    copy: {
      eyebrow: 'Secure sign-in',
      headline: 'Sign in once. Your fuel audits run themselves.',
      bullets: [
        'One account for the extension and the gnbedge platform',
        'No separate telematics password to manage or rotate',
        'Every session is scoped to your own organisation',
      ],
    },
  },
  {
    file: 'cws-screenshot-dashboard.png',
    state: dashboardState(),
    copy: {
      eyebrow: 'Live task status',
      headline: 'See every audit task without leaving the tab.',
      bullets: [
        'Pending, completed, flagged and failed counts at a glance',
        'Link your fleet portal in one click — the session is cleared after',
        'Pull on demand, or let the background refresh keep it current',
      ],
    },
  },
];

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error('dist/ not found — run "npm run build" first.');
    process.exit(1);
  }

  const { chromium } = require('@playwright/test');
  const { server, port } = await serveDist();
  const base = 'http://127.0.0.1:' + port;
  const browser = await chromium.launch();

  try {
    for (const shot of SHOTS) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      await page.addInitScript({ content: chromeStub(shot.state, VERSION) });
      await page.goto(base + '/index.html', { waitUntil: 'networkidle' });
      await page.waitForSelector('.gnb-popup', { timeout: 15000 });
      // The popup polls GET_STATUS on mount; give it a beat to leave "loading…".
      await page.waitForTimeout(500);
      if (shot.prefill) {
        const fields = page.locator('.gnb-field input');
        await fields.nth(0).fill(shot.prefill.email);
        await fields.nth(1).fill(shot.prefill.password);
        // Drop focus so no field carries a focus ring into the shot.
        await page.locator('.gnb-login-head h1').click();
      }
      await page.evaluate(applyFrame, shot.copy);
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(ROOT, shot.file) });
      await page.close();
      console.log('✓ ' + shot.file + '  1280x800');
    }

    const tile = await browser.newPage({ viewport: { width: 440, height: 280 } });
    await tile.goto(base + '/index.html', { waitUntil: 'domcontentloaded' });
    await tile.evaluate(applyTile);
    await tile.waitForTimeout(250);
    await tile.screenshot({ path: path.join(ROOT, 'cws-promo-tile-440x280.png') });
    await tile.close();
    console.log('✓ cws-promo-tile-440x280.png  440x280');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('Screenshot build failed:', err.message);
  process.exit(1);
});
