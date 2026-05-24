# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please **do not** open a public issue.

Instead, report it privately via one of these channels:

- **GitHub Security Advisory**: [Open a private advisory](https://github.com/GNB-motors/plugin/security/advisories/new)
- **Email**: devayandewri@gmail.com

Please include:
- A description of the vulnerability
- Steps to reproduce (if applicable)
- Potential impact
- Suggested fix (if you have one)

## Response Timeline

| Severity | Acknowledgement | Patch Target |
|----------|----------------|--------------|
| Critical | 24 hours | 7 days |
| High | 48 hours | 14 days |
| Medium | 72 hours | 30 days |
| Low | 1 week | Next release |

## Supported Versions

Only the latest released version on the Chrome Web Store receives security updates.

| Version | Supported |
|---------|-----------|
| Latest (see `extension/manifest.json`) | ✅ Yes |
| Older versions | ❌ No |

## Security Measures in Place

- **Manifest V3** with minimal permissions (`storage`, `alarms`, `notifications`)
- **No `webRequest`, `scripting`, or `tabs` permissions**
- All FleetEdge API calls happen **server-side** via the backend
- Content scripts use the **declared** (not programmatic) injection model
- Extension tokens are read from page context and forwarded to backend over HTTPS
- CI runs `npm audit`, CodeQL, dependency review, and custom secret scanning on every PR

## Known Security Considerations

- The extension reads JWT tokens from `fleetedge.home.tatamotors` via a declared content script. Users must explicitly grant this host permission at runtime.
- Backend tokens are stored in `chrome.storage.local` and transmitted via `Authorization: Bearer` headers.
