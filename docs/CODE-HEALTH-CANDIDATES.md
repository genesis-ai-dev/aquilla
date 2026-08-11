# Code Health Candidates

Opportunities found during `/code-health` runs that exceeded that run's budget
(~300 changed lines, ~8 files). Logged here instead of actioned. Prune entries
a later run completes.

## 2026-08-11 — dead code deletion run

Found via exhaustive repo-wide grep (`src/`, `auth-worker/`, `sync-worker/`,
`agent-worker/`, `worker/`, `e2e/`, `scripts/`) during a dead-code sweep. This
run's budget was spent on `CellActionsMenu.tsx`, `ProgressDot.tsx`,
`NextUnfinishedButton.tsx`, `commit-message.ts`, and the deprecated
`pendingGroup`/`pendingSection` fields in `EditorScrollContext.tsx`
(~260 lines, 5 files). The following were verified dead (zero importers) but
didn't fit:

- **`src/lib/sync/settings-read.ts` + `src/lib/sync/settings-read-types.ts`**
  (~106 lines). Header comment describes it as an alias layer for
  `useProjectSettings`, but that hook imports directly from
  `@/lib/sync/project-settings` and never touches this file. Zero importers
  of `fetchProjectSettings`/`writeProjectSettings`/`SettingsReadError`
  anywhere. Proof needed: same grep sweep, re-verify against any new callers
  added since this note.
- **`src/lib/sync/sync-debug.ts`** (~125 lines). Exports
  `isSyncDebugEnabled`, `attachSyncDebug`, `logEffectShortCircuit` — zero
  references outside its own definition.
- **`src/lib/timeline/diarization-loader.ts`** (~122 lines). Exports
  `loadDiarizer`, `DIARIZATION_ASSET_BASE`, `Diarizer`/`DiarizeOptions` —
  zero references; diarization/waveform code elsewhere in `src/lib/timeline/`
  and `src/lib/audio/` doesn't call it.

These three alone are ~350 lines / 3 files — a full budget on their own for a
future run. Re-verify deadness with a fresh grep before deleting (time may
have passed).

## Lower-priority: unwired shadcn UI primitives

Not confirmed-abandoned features, just scaffolding that was never wired up —
lower confidence than the above, so lower priority. Zero imports/JSX
references anywhere in `src/` as of 2026-08-11:

- `src/components/ui/toggle-group.tsx` (~89 lines)
- `src/components/ui/item.tsx` (~201 lines)
- `src/components/ui/attachment.tsx` (~207 lines)

Proof needed: re-grep for imports/JSX usage; confirm still unreferenced
across all four brands (`aquilla`, `codex`, `honeycomb`, `context`) before
deleting, since shadcn primitives are sometimes brand-gated.
