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

## How I tested

- [ ] `npm test` passes locally (187 tests)
- [ ] `npm run lint` passes
- [ ] `npm run build` produces a clean `dist/`
- [ ] Loaded `dist/` into Chrome and verified the affected flow end-to-end

## CWS impact

- [ ] No version bump needed (internal refactor only)
- [ ] Patch bump (e.g. `0.0.0.2` → `0.0.0.3`)
- [ ] Minor/major bump with new permissions (requires CWS re-justification)
