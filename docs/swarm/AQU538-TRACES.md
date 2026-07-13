# AQU-538 swarm — open traces / TODOs for the next agent

Add a `SWARM-TODO(AQU-538): <what>` entry here (and a matching code comment where
relevant) for anything you defer. The orchestrator drains this list before the final gate.

## Open

- SWARM-TODO(AQU-538): `useProject.ts`'s `overlaySettings()` doesn't merge
  `targetLanes`, so the LaneSwitcher never renders even after adding a lane.
  `src/hooks/useProject.ts` (`overlaySettings`, ~lines 28-70) assigns every
  other synced `ProjectWideSettings` field (`sourceLanguage`, `targetLanguage`,
  `rules`, `terminology`, …) onto the `ProjectRecord` via `assign(...)`, but
  has no `assign("targetLanes", settings.targetLanes)` call — `targetLanes`
  was added to the `ProjectWideSettings` interface at
  `src/lib/sync/project-settings.ts:94`, but `useProject.ts` was never
  updated to overlay it. `ProjectWorkspace.tsx` (~line 1120) computes
  `targetLanes`/`availableLanes` off `project.targetLanes`, which is the
  `useProject()`-returned (settings-overlaid) record — so it's permanently
  `undefined`/`[]` there, even though the Languages section
  (`src/components/ProjectSettings/LanguagesSection.tsx`) correctly
  writes/lists lanes via `GET/PATCH /api/v2/projects/:id/settings`. Net
  effect: a lane added in Settings is persisted and shows in the
  `target-lanes-list`, but the workspace header's `LaneSwitcher`
  (`data-testid="lane-switcher"`) never appears, so the editor can never be
  pointed at the non-default lane through the UI.
  - Repro path: `e2e/specs/projects/add-target-language.spec.ts` (new, this
    wave) — fails deterministically on
    `await expect(ws.laneSwitcher()).toBeVisible(...)` right after adding
    lane "es" via Settings and returning to the workspace.
  - Fix shape (not applied here — e2e/** only): add
    `assign("targetLanes", settings.targetLanes)` to `overlaySettings()` in
    `src/hooks/useProject.ts`, then drop the defensive
    `(project as { targetLanes?: string[] })` cast + stale SWARM-TODO comment
    in `ProjectWorkspace.tsx` (~line 1117-1123) and in
    `LanguagesSection.tsx` (top-of-file comment, lines ~15-20) once it reads
    `ProjectWideSettings["targetLanes"]` directly.

## Resolved

- (none yet)
