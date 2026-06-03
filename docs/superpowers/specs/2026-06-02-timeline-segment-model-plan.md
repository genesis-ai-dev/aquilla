# Implementation Plan — Timeline-Anchored Segment Model (Scope A)

Spec: `2026-06-02-timeline-segment-model-design.md`
Branch: `feat/timeline-segment-model` · Worktree: `../codex-web-app-timeline`

Work top-to-bottom. Each step ends with: typecheck/lint/relevant tests green,
a focused commit, and the checkbox ticked. Keep changes additive and surgical.

## Step 1 — Schema + defaults  ✅
- [x] Add `orderedBy?: 'time' | 'sequence'` to `FileReference` (`src/lib/parsers/types.ts`). Helper `fileOrderedBy(f)` defaulting to `'sequence'`.
- [x] Add `sequenceIndex?`, `medium?`, `transcription?`, `cameraState?` to `CellRow` (`src/lib/sync/cells-read-types.ts`) + `SegmentMedium`/`CameraState` types.
- [x] Surface the same fields on `CellData` (`src/hooks/useCells.ts`) + map in `buildCellData` (`medium` defaults `'text'`).
- [x] Ordering scheme decided: **fractional `sequenceIndex`** (insert = midpoint of neighbors). Implemented in Step 2's `derive.ts`.
- [x] Typecheck (tsc -b) clean. Commit.

## Step 2 — Read path + derived helpers  ✅
- [x] `useCells.buildCellData` maps the new `CellRow` fields onto `CellData` (done in Step 1).
- [x] New pure module `src/lib/timeline/derive.ts`: `timelineBounds`, `overlapsOf`, `sortByLens`, `hasTiming`, `rangesOverlap`, `sequenceBetween`. 15 unit tests, all green.
- [x] Typecheck + tests clean. Commit.

## Step 3 — Lens toggle + media layer + file icons  ◑ (3a–3c done, 3d pending)
- [x] **3a** File-list icon per `orderedBy` (`FileRow`: waveform=time, list=sequence).
- [x] **3b** Toggle relabel: `EditorModeToggle` shows "Media" (waveform) for time files, "Audio" otherwise. **Decision:** toggle is NOT hidden for sequence files (would break audio-Bible editing); only its semantics change for time files. Flagged for user review.
- [x] **3c** Medium-layer switch: `EditorTable.displayCells` filters by `medium` + sorts by time, gated on `orderedBy==='time'` (non-time files byte-identical). Empty-state hint. Index-based voice paths left on full list (known Part-B limit).
- [x] **3d-plumbing** Full write→projection→read round-trip for `medium`/`sequenceIndex`/`transcription`/`cameraState` + file `orderedBy` (migration 0025; sync-worker projection + both read routes; auth-worker projects route; client emit/outbox + `CloudFileSummary`→`FileReference`). Create-time only. Client + sync-worker tsc clean.
- [ ] **3d-ui** Untimed "no specific timing" ghost-row treatment in the time lens + lens-disagreement indicator (display-only, EditorRow). Inline camera/transcription EDITING deferred to Part B (create-time only for now).
- [x] Typecheck clean. Committed (3a, 3b/3c, 3d-plumbing).

## Step 4 — Recorder decoupling  ✅
- [x] Verified structural: recorder `targetSec` = active cell's own `startTime/endTime`. In the media layer the active cell IS a media segment, so its own timing is the target — the subtitle coupling is gone by construction. Documented the invariant in `AudioRecordingModal`. Sequence files unchanged.

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
