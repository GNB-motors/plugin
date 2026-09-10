# gnbedge — GNB Edge Plugin (repo root)

This repo holds the shipped Chrome extension plus two auxiliary pieces that are
**not** part of the shipped product. If you're looking for what the extension
actually does, stop here and go to **[`extension/README.md`](./extension/README.md)**
— that is the canonical, current architecture doc (multi-account FleetEdge
linking, the backend-direct design, permissions, message-passing surface, the
full data flow). This file only orients you around the repo layout.

> **This file previously described a "v2.0.0" single-account architecture**
> (one `link-token` call, no per-account status, `{ "status": "linked" }`
> responses). That was itself a description of an intermediate design that has
> since been superseded by the multi-account model — see
> `extension/README.md`'s own "Migration notes" section for the full history.
> Nothing here should be read as the current contract; it always drifted
> because two full architecture write-ups existed and only one was maintained.

---

## What's in this repo

| Path | What it is | Is it part of the shipped product? |
|---|---|---|
| [`extension/`](./extension/) | The actual Chrome extension (Manifest V3) — source, tests, build tooling, CWS submission docs | **Yes** — this is the thing that ships |
| [`server.js`](./server.js) + root [`package.json`](./package.json) | A local Express mock backend implementing the *legacy* task-polling endpoints (`GET /api/tasks/pending`, `POST /api/tasks/:id/result`, `POST /api/tasks/:id/error`) | No — tests **Pipeline A**, which `extension/README.md` documents as disabled by default (`FEATURE_EXTENSION_TASK_POLLING=false`; those backend endpoints return `410` unless it's set). See [`REAL_LIFE_TESTING.md`](./REAL_LIFE_TESTING.md), which walks through it and now flags this. |
| [`fleetedge_fuel_consumption.py`](./fleetedge_fuel_consumption.py) | A standalone Playwright-based prototype scraper for capturing a FleetEdge JWT and calling its fuel-consumption API directly | No — an early exploration script, unrelated to the shipped extension's content-script capture approach. Not run in CI. |

## Docs map

| Doc | Audience | Covers |
|---|---|---|
| [`extension/README.md`](./extension/README.md) | Everyone | **Start here.** Current architecture, data flows, permissions, message API, install/build/troubleshooting |
| [`AGENTS.md`](./AGENTS.md) | AI/human contributors | Repo conventions, branch strategy, CI, what not to do without asking |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | Human contributors | PR workflow, commit format, code review |
| [`DEV_HANDBOOK.md`](./DEV_HANDBOOK.md) | Engineers | Deeper dev-environment and debugging reference (older; cross-check version-specific examples against `extension/README.md`) |
| [`extension/TESTING.md`](./extension/TESTING.md) | Engineers | Test suite structure, mocking patterns, how to add tests |
| [`extension/CWS_SUBMISSION.md`](./extension/CWS_SUBMISSION.md) | Whoever submits to the Chrome Web Store | Paste-ready dashboard copy, permission justifications, upload checklist |
| [`SECURITY.md`](./SECURITY.md) | Anyone reporting a vuln | Reporting process, security measures in place |
| [`REAL_LIFE_TESTING.md`](./REAL_LIFE_TESTING.md) | QA / manual testers | Local mock-backend walkthrough — see the caveat above about which pipeline it tests |

## Quick start

```bash
cd extension
npm install
npm run build          # → dist/
npm test                # 277 tests, 2 skipped
```

Load `dist/` into Chrome at `chrome://extensions/` → **Developer mode** →
**Load unpacked**. Full instructions, including first-time account linking,
are in `extension/README.md`.

## License

MIT — see [`LICENSE`](./LICENSE).
