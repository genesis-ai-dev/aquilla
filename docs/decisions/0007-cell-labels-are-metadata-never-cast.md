# 0007 — Cell labels are metadata, never cast

*Decided 2026-11-05 (Matt, AQU-2408); recorded the same day.*

## Context

A translator or checker wants to tag a line for their own reasons — a pericope
heading, "needs consultant", a section name — on an ordinary text cell with no
media, no cast and no voice. Until AQU-2408 the only labels the editor could
show in a cell's corner came from the voice world: the assigned voice's name,
then the line's character (`metadata.cast_name`, written by `cast.assign`).
Every screen that wrote a character name also minted a voice into the project's
library — the character-sheet import, VTT speaker tags, diarization, the
spreadsheet Cast column — so the only way to label a text cell was to invent a
speaker for it. The one voice-free path, the AQU-1369 metadata chips, could show
imported metadata but could not be typed, and lived in one browser's
localStorage.

A third rung already existed in the corner-label ladder, `CellData.cellLabel`,
read by a dozen surfaces (`src/components/EditorTable.tsx::EditorTable`, the
playback bar, the recording modal, check findings, footnotes) and indexed by
scoped search (`sync-worker/src/events/scoped-search.ts`) — but nothing
populated it any more. Only migrated Codex notebooks carried
`metadata.cellLabel`, where it had doubled as the speaker name (AQU-1942).

## Decision

1. **A cell label is metadata.** It is stored as `metadata.cellLabel` on the
   cell's SOURCE row — the same key legacy Codex notebooks carry — by a new
   non-chain-mutating event, `cell.label.set` (`sync-worker/src/events/types.ts`,
   payload `{ label: string | null }`). The projection
   (`sync-worker/src/events/event-projection.ts::buildEventProjectionStmts`)
   merges that one key, per key, exactly as `cast.assign` merges `cast_name`:
   it never touches `value`, `event_id` or `validated`, never takes the chain
   claim, and never bumps the AD-9 staleness pin. Null or blank removes the key.
2. **A label never becomes a character or a voice.** Nothing outside the Codex
   migration's speaker collector (`src/lib/migrate/map.ts::collectSpeakers`)
   may route `cellLabel` through `castLikeSpeakers` or `buildSpeakerCastWrite`
   (`src/lib/import/cast-from-speakers.ts`). Subtitle exports write no `<v>`
   tag from it; character-sheet and project-report exports read `cast_name`
   only. The Gemini voice-prompt context no longer receives `cellLabel`
   (`src/lib/audio/gemini-tts.ts::buildGeminiTtsPrompt` renders the
   `{cellLabel}` placeholder empty) — a label is a note, not voice direction.
3. **The ladder is unchanged.** The corner shows the assigned voice's name, then
   the line's `cast_name`, then its `cellLabel`. On a media file a cast name
   therefore wins; a typed label fills the slot only on lines nobody cast.
   `src/hooks/useCells.ts::buildCellData` maps the source row's key onto
   `cellLabel` (trimmed, non-empty strings only), which also makes migrated
   notebooks show their old labels in the corner — what AQU-1018 asked for.
4. **Who may type one is a project setting with two rungs.** `cellLabelFloor`
   is `maintainer` (the default when absent) or `project_lead`; no other value
   is offered or accepted (`db/shared/project-settings-keys.ts`). It follows the
   `cellEditingFloor` arrangement: the sync perimeter applies only the event's
   static floor, PROJECT_LEAD (`sync-worker/src/events/role-policy.ts::REQUIRED_ROLE`,
   mirrored in `src/lib/sync/role-policy.ts::requiredRoleFor`), and the tier is
   enforced where the field is drawn, by `src/lib/cell-label-gate.ts::canEditCellLabel`
   (client copy `src/lib/sync/project-settings.ts::resolveCellLabelFloor`,
   server copy `db/shared/cell-label-floor.ts::cellLabelFloorFromSettings`,
   kept in lock-step). An unknown tier value reads as maintainer, never lower.
5. **Where it is typed.** A Label row at the top of the cell's expansion panel
   (`src/components/CellLabelRow.tsx::CellLabelRow`): editable at or above the
   tier, read-only text below it, absent when there is no label and the viewer
   cannot set one. Each change is one undo step
   (`src/lib/history/label-steps.ts::cellLabelStepHandlers`), a plain re-write
   guarded by the label's current value rather than a chain head.

## Consequences

- Any surface that already fell back to `cell.cellLabel` starts showing typed
  labels and migrated Codex labels at once, with no further wiring.
- Reusing the key means a migrated notebook's old speaker labels appear in the
  corner too. That is intended (AQU-1018); they are still never re-minted as
  voices, because the migration is the only place that reads the key as one.
- A label is source-side and lane-free: one label per cell, shown in every
  language, undoable from any lane.
- The event is a new kind, so the replay corpus golden is regenerated with it;
  no existing corpus carries the kind, so no projection row changes.

## Not covered yet

- The Agent API and MCP surface do not expose `cell.label.set`; agents cannot
  label cells, and auth-worker's agent staging does not consult the tier.
- Linked-project mirroring (`sync-worker/src/events/link-sync.ts`) does not
  treat a label change as a lane-relevant upstream change; a downstream copy
  picks a label up with the next mirror the upstream triggers otherwise.
- No export carries typed labels, and no spreadsheet import writes the key
  directly (a mapped ref column still lands as `spreadsheetLabel`).
- Labels are free text: no vocabulary, pick-list, colour or per-project list.
