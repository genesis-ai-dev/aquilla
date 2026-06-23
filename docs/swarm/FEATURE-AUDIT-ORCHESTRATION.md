# Feature Audit & QA Orchestration

Goal (from `/goal`):
1. Enumerate **every feature** → user story + expected behavior derived from code → **single canonical spreadsheet** tracking status. → `docs/FEATURE-STORIES.csv`
2. `/loop` test every user story, document all errors. → status column flips to `Tested-Pass` / `Tested-Fail` + `docs/swarm/FEATURE-QA-ERRORS.md`
3. Fix every logistical / UX error found.
4. Re-test every user behavior post-fix.

## STOP criteria
- [x] Phase 1: `docs/FEATURE-STORIES.csv` — 688 features, 22 areas. DONE.
- [ ] Phase 2: every row tested in the running app; failures logged with repro + screenshot in `FEATURE-QA-ERRORS.md`.
- [ ] Phase 3: every logged logistical/UX error fixed on an integration branch, tsc+vitest+build green.
- [ ] Phase 4: every previously-failing story re-tested green; CSV status reflects final state.

## Canonical artifacts
- `docs/FEATURE-STORIES.csv` — the single source of truth spreadsheet.
- `docs/swarm/FEATURE-QA-ERRORS.md` — Phase 2 error log.
- This file — orchestration log.

## Notes
- `docs/v3-audit/` is STALE (pre-event-log-reimpl). Comments/Living Memory/Search/Export/Terminology all have passing e2e specs now. Derive status from CURRENT code only.
- `e2e/JOURNEYS.md` (~80 journeys → 301 specs) is the journey backbone.
- Route map: `src/App.tsx`.

## Phase 2 testing strategy
Backbone (running): `npm run build` (tsc+vite), `npm run test` (vitest, 360 files), `npm run test:e2e:smoke`, then full `npm run test:e2e` (301 specs). These encode most of the 688 stories → failures go to FEATURE-QA-ERRORS.md.
Manual real-UI walkthrough: golden path + the 368 Implemented-without-e2e features + spot-check Partial UI states.
**Out of scope for Phase 3 fixes:** the 24 Partial/Stub/Gap rows are documented deferred work (Phase 2b/v1.x, server-grammar-blocked, SWARM-TODOs) — NOT defects. Phase 3 targets only genuine logistical/UX bugs surfaced in Phase 2.

## Merge log
(empty — Phase 1 is read-only doc generation)
