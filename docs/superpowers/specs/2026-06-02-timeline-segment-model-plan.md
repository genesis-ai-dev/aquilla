# Implementation Plan — Timeline-Anchored Segment Model (Scope A)

Spec: `2026-06-02-timeline-segment-model-design.md`
Branch: `feat/timeline-segment-model` · Worktree: `../codex-web-app-timeline`

Work top-to-bottom. Each step ends with: typecheck/lint/relevant tests green,
a focused commit, and the checkbox ticked. Keep changes additive and surgical.

## Step 1 — Schema + defaults
- [ ] Add `orderedBy?: 'time' | 'sequence'` to `FileReference` (`src/lib/parsers/types.ts`). Helper `fileOrderedBy(f): 'time'|'sequence'` defaulting to `'sequence'`.
- [ ] Add `sequenceIndex?: number`, `medium?: 'text' | 'media'`, `transcription?: string`, `cameraState?: 'on'|'mixed'|'off'` to `CellRow` (`src/lib/sync/cells-read-types.ts`).
- [ ] Surface the same fields on `CellData` (`src/hooks/useCells.ts`) with defaults (`medium` → `'text'`).
- [ ] Decide ordering scheme for in-between inserts (fractional ranks). Document the helper.
- [ ] Typecheck. Commit.

## Step 2 — Read path + derived helpers
- [ ] In `useCells.buildCellData`, map new `CellRow` fields onto `CellData`.
- [ ] New pure module `src/lib/timeline/derive.ts`: `timelineBounds(cells)`, `overlapsOf(cell, cells)`, `sortByLens(cells, orderedBy)`. Unit tests for each.
- [ ] Typecheck + tests. Commit.

## Step 3 — Lens toggle + media layer + file icons
- [ ] Gate the editor text/audio toggle on `orderedBy === 'time'`; make it a `medium` layer switch (text segments vs media segments).
- [ ] Media-layer row: timing, camera-state control (`on/mixed/off`), transcription field, take(s). Reuse existing audio/cell components.
- [ ] Untimed-in-time-lens treatment (dashed/ghost row); lens-disagreement indicator.
- [ ] File-list icon per `orderedBy`.
- [ ] Typecheck. Commit.

## Step 4 — Recorder decoupling
- [ ] In a `time` file, recorder `targetSec` comes from the media segment's own `startTime/endTime` (not a subtitle window). Sequence files unchanged (attachment-on-cell).
- [ ] Typecheck. Commit.

## Step 5 — Unified import picker
- [ ] Ingest entry: "What are you starting from?" → Subtitles / Audio / Video / Text.
- [ ] Routes set `orderedBy` + initial `medium` per spec table. Audio/Video = single media segment spanning file (Scope A B-option). Subtitles + Text reuse existing paths.
- [ ] Typecheck. Commit.

## Step 6 — Verify in real UI
- [ ] Run the `verify-dev-change` workflow: VTT import → time/text file; audio import → time/single-media file; USFM import → unchanged sequence/text; toggle lens changes only order; record on media segment uses its own timing.
- [ ] Fix anything broken. Final commit.

## Done criteria (from spec Success Criteria)
- [ ] All success criteria in the spec verified in the running app.

---

## Part B (only after Scope A done + no overnight response)
- [ ] Silence-split ingest for audio/video (auto-segment by silence).
- [ ] Speaker diarization → auto-cast on import.
- [ ] (Stretch) waveform snap-and-stretch; combined three-track view.
