# Changelog

All notable changes to this project will be documented in this file.

## [2026-07-25] — branch: feat/refresh-token-capture

### Added
- `networkSpy.js` now captures the FleetEdge refresh token: `/api/user-general/` added to the allow-list, and both the XHR and fetch spies post a `FLEETEDGE_REFRESH_INTERCEPT` message when the Basic-auth `get-token-by-refresh-token` endpoint returns 2xx (refresh token taken from the response body, falling back to the request body).
- `fleetedgeTokenReader.js` accepts validated `FLEETEDGE_REFRESH_INTERCEPT` messages (same origin/source checks) and includes `refreshToken` in the `READ_FLEETEDGE_TOKEN` reply.
- `fleetedgeLink.js` forwards the captured `refreshToken` (or `null`) to the backend on `POST /fleetedge/link-token`.

## [Unreleased]

### Dependencies
- Bump `express` from 4.22.1 to 4.22.2
- Bump `qs` from 6.14.2 to 6.15.2
// CodeRabbit test commit
