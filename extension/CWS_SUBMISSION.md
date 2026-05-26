# Chrome Web Store Submission — gnbedge

Paste-ready text for every field on the Developer Dashboard. Email on file: **devayandewri@gmail.com**.

---

## 1. Store listing

### Item name
```
gnbedge
```

### Short description (≤132 chars)
```
Connects to your fleet telematics provider and audits fuel consumption tasks through your organization backend.
```

### Detailed description
```
gnbedge is a companion extension for the gnbedge fleet operations platform. It securely bridges your authenticated session at your fleet telematics provider with your organization's gnbedge backend so that fuel-consumption audit tasks run end-to-end without manual data entry.

Features
• Sign in once with your gnbedge account (email or mobile + password)
• One-click "Connect Fleet Portal" that links your existing telematics session — no separate password to manage
• Live task status: pending, completed, failed, and flagged counts
• On-demand "Pull from FleetEdge now" trigger
• Automatic 24-hour token expiry handling
• Local logs viewer for support and troubleshooting

Permissions used
• storage — saves your sign-in state and configuration locally
• alarms — schedules a 2-minute background status refresh
• notifications — alerts you when your fleet portal session expires
• Host access to api.app.gnbedge.in — your organization backend (HTTPS)
• Fleet portal access — requested only when you click Connect Fleet Portal (optional permission, not granted at install)

Privacy
We don't sell or share your data. No analytics, no tracking, no third-party services. See the privacy policy linked below.

Support
Questions: devayandewri@gmail.com
```

### Category
`Productivity` (alternative: `Workflow & Planning Tools`)

### Language
English

---

## 2. Privacy practices

### Single purpose description
```
Bridges an authorized fleet telematics session with the user's organization backend so that fuel-consumption audit tasks can be processed end-to-end.
```

### Permission justifications

| Permission | Justification text |
|---|---|
| `storage` | Persists the user's sign-in token, backend URL, and last-seen task counts locally so the popup can render quickly and the service worker can resume after restarts. |
| `alarms` | Schedules a 2-minute periodic background refresh that polls the user's organization backend for task status and token validity. |
| `notifications` | Alerts the user when their fleet portal session token expires (~24h) so they know to reconnect. |
| Host: `https://api.app.gnbedge.in/*` | The user's organization backend. The extension sends authentication requests, retrieves task status, and forwards the fleet portal token here. All traffic is HTTPS. The manifest also declares `externally_connectable` for `https://app.gnbedge.in/*` (production web app) and `https://main-frontend-wine.vercel.app/*` (development frontend); these origins can send a single `{ type: "PING" }` message during the user onboarding flow so the web app can detect that the extension is installed. The extension responds only with `{ ok: true, version }` and exposes no user data or authenticated state via this channel. |
| Optional host: `https://fleetedge.home.tatamotors/*` | **Requested at runtime only — not granted at install.** The user must explicitly click "Connect Fleet Portal" to trigger the permission prompt. Once granted, two declared content scripts run on this host: one reads the user's existing authenticated session token from the page's network requests (MAIN world), and passes it to the extension's isolated context, which forwards it to the user's backend. The extension never injects data, never reads other sites, and the host is never accessed without an explicit user action. |

### Remote code use
```
No
```
The extension does not load or execute any remotely hosted JavaScript, WASM, or CSS. All scripts are bundled at build time.

### Data usage disclosures (checkboxes)
- Personally identifiable info — **YES** (email and mobile during sign-in)
- Authentication info — **YES** (JWTs)
- Health info — No
- Financial / payment info — No
- Personal communications — No
- Location — No
- Web history — No
- User activity (clicks, scrolls) — No
- Website content — No

### Required certifications (must check all three)
- ✅ I do not sell or transfer user data to third parties, outside of the approved use cases
- ✅ I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- ✅ I do not use or transfer user data to determine creditworthiness or for lending purposes

### Privacy policy URL
```
https://gnb-motors.github.io/gnbedge-pages/
```
Hosted from the `GNB-motors/gnbedge-pages` repo via GitHub Pages. Support URL: `https://gnb-motors.github.io/gnbedge-pages/support.html`. Edit the HTML in that repo and push to `main` — Pages redeploys automatically. Do not host these from personal GitHub Pages (`<username>.github.io`); a previously flagged account broke this once.

---

## 3. Distribution

### Visibility
Recommended: **Unlisted** (link-only, won't appear in Chrome Web Store search). Switch to Public after the integration is licensed for general distribution.

### Regions
All regions, OR restrict to India if this is an internal-only tool.

---

## 4. Required assets to upload

| Asset | Size | Required? | Status |
|---|---|---|---|
| Icon 128×128 | 128×128 PNG | Yes (already in zip) | ✅ |
| Screenshot | 1280×800 or 640×400 PNG/JPEG | Yes (1–5) | ⚠️ TODO |
| Small promo tile | 440×280 PNG/JPEG | Yes | ⚠️ TODO |
| Marquee promo tile | 1400×560 | Optional | skip |

See `screenshot-instructions.txt` for the fastest way to produce these.

---

## 5. Hosting the privacy and support pages

Already done. Privacy + support are served from `GNB-motors/gnbedge-pages` as GitHub Pages:

- Privacy: `https://gnb-motors.github.io/gnbedge-pages/`
- Support: `https://gnb-motors.github.io/gnbedge-pages/support.html`

To edit: clone `GNB-motors/gnbedge-pages`, modify `index.html` (privacy) or `support.html`, push to `main`. Pages rebuilds in ~1 minute.

Do **not** host these from a personal GitHub account (`<username>.github.io`) — if that account is ever flagged, both URLs become unreachable and CWS rejects the next submission. Keep them under the org.

---

## 6. Known review risk

The host permission `https://fleetedge.home.tatamotors/*` references a Tata Motors property. If the reviewer asks for proof of authorization, respond with whatever business agreement / contractor relationship covers your access to that portal. Without it, expect rejection on trademark grounds even though the extension name has been changed to a neutral one.

---

## 7. Upload checklist

- [ ] `npm run build` produces a clean `dist/`
- [ ] `dist/manifest.json` has version `0.0.0.3` (or higher), name `gnbedge`, no `tabs` permission, no `localhost` host, `externally_connectable` lists only prod + dev frontends
- [ ] `dist/` does NOT contain `vite.svg`, `icons/README.md`, or any `*.map` files
- [ ] Zip the **contents** of `dist/`, not the folder itself, so `manifest.json` is at the zip root
- [ ] Privacy policy hosted at a public HTTPS URL
- [ ] One 1280×800 screenshot ready
- [ ] One 440×280 promo tile ready
- [ ] Pay $5 developer registration fee (one-time, if not already paid)
