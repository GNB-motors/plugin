# Contributing to gnbedge

Thanks for your interest in contributing! This document covers the basics for human contributors. For AI-agent conventions, see [`AGENTS.md`](./AGENTS.md).

## Quick Start

All development happens inside the `extension/` directory:

```bash
cd extension
npm install
```

## Development Workflow

1. **Branch from `main`** (or `Devayan` for active development)
2. **Make your change** with tests
3. **Run quality gates locally**:
   ```bash
   npm run lint      # ESLint
   npm test          # Vitest (187 tests)
   npm run build     # Production build
   npm run check:security  # Manifest + secrets + audit
   ```
4. **Fill the PR template** — the CWS impact checklist is required
5. **Open a PR** — CI will run automatically

## Commit Message Format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(background): add retry logic for token refresh
fix(popup): resolve memory leak on unmount
docs: update CWS submission notes
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Allowed scopes: `extension`, `popup`, `background`, `content`, `ci`, `docs`, `tests`, `deps`, `manifest`, `api`, `auth`, `fleetedge`, `telemetry`

## What NOT to do

- Do **not** bump `manifest.json` version silently — it's tied to CWS submission
- Do **not** add new `chrome.*` permissions without explicit approval
- Do **not** push directly to `main`
- Do **not** remove or rename test files without updating the count in README/CHANGELOG

## Code Review

All PRs require:
- 1 approving review
- All CI checks passing (Validate, Smoke, CodeQL, Dependency Review)
- No unresolved review threads
- Branch up-to-date with `main`

## Questions?

Open a [GitHub Discussion](https://github.com/GNB-motors/plugin/discussions) or email devayandewri@gmail.com.
