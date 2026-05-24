<!-- Fixes #N -->

## Why

<!-- What problem does this solve? What was the user pain? -->

## What changed

<!-- Brief description of the change from a user/reviewer perspective, not a code description -->

## Surface area

- [ ] Manifest / permissions changed (requires new CWS justification)
- [ ] Backend API contract changed (requires backend sync)
- [ ] Content script behaviour changed (requires re-test on FleetEdge)
- [ ] Popup UI changed (screenshot below)
- [ ] Dependency added/removed/upgraded
- [ ] Tests added / updated

## Screenshots

<!-- Required if Popup UI box is checked. Drag-and-drop images here. -->

## Explainer

<!-- In 1-2 sentences: why did you choose this approach over alternatives? What trade-offs did you make? -->

## How I tested

- [ ] `npm test` passes locally (187 tests)
- [ ] `npm run lint` passes
- [ ] `npm run build` produces a clean `dist/`
- [ ] Loaded `dist/` into Chrome and verified the affected flow end-to-end

## Test coverage

- [ ] New feature includes tests (not just the happy path)
- [ ] Edge cases are covered (errors, timeouts, invalid input)
- [ ] Existing tests still pass; coverage not dropped
- [ ] No tests needed (explain why below)

<!-- If you checked "No tests needed", explain why in 1 sentence -->

## CWS impact

- [ ] No version bump needed (internal refactor only)
- [ ] Patch bump (e.g. `0.0.0.2` → `0.0.0.3`)
- [ ] Minor/major bump with new permissions (requires CWS re-justification)
