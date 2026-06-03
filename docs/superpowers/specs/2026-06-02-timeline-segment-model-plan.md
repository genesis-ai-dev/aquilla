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
- [x] **3d-ui** Untimed "no specific timing" flag in the time lens (dashed amber left-accent + "no timing" chip on the row wrapper — no EditorRow surgery). Lens-disagreement indicator: deferred as a low-value nicety. Inline camera/transcription EDITING deferred to Part B (create-time only for now).
- [x] Typecheck clean. Committed (3a, 3b/3c, 3d-plumbing).

## Step 4 — Recorder decoupling  ✅
- [x] Verified structural: recorder `targetSec` = active cell's own `startTime/endTime`. In the media layer the active cell IS a media segment, so its own timing is the target — the subtitle coupling is gone by construction. Documented the invariant in `AudioRecordingModal`. Sequence files unchanged.

## Step 5 — Unified import  ◑ (5a done, 5b net-new)
- [x] **5a Subtitles → time / Text → sequence.** Threaded `orderedBy` + cell `sequenceIndex`/`medium` through the dedicated `/import` path (import.ts, bulk-import.ts, sync-worker import-route.ts). VTT/SRT now open time-ordered → layer switch activates. USFM/text stay sequence. New `orderedByForFileType`; tests green.
- [x] **5b Audio/Video file import → time / single media segment.** FileType `'audio'|'video'` + `detectFileType` + `isMediaFileType`; `importFile` routes media to `emitMediaFile` (time-ordered file + one `medium:'media'` cell, timing = probed duration or untimed+flagged; R2 upload + attach; orphan cleanup); ImportDialog accept list extended. +6 tests. Client tsc clean.
- [x] Typecheck + tests. Committed.

## Step 6 — Verify in real UI  ✅
- [x] Drove the running dev stack (worktree build `feat/timeline-segment-model@270697e`) via Playwright as the seeded `dev` user. Verified:
  - VTT import → time-ordered file (waveform icon; toggle relabels Audio→Media); Text layer shows 3 timed segments + speaker→cast labels; Media layer empty-state.
  - WAV import → second time-ordered file with exactly 1 `medium:'media'` segment; Text layer "No text segments", Media layer shows it. Proves `orderedBy` + `medium` round-trip through D1 projection → read → editor.
  - No console errors except a benign font 403 (Vite `/@fs` path-allow quirk from the symlinked node_modules — not a code issue).
- [x] Dev-stack-from-worktree gotcha found + fixed: workers are workspace packages needing their OWN node_modules; symlinked `auth-worker/` + `sync-worker/` node_modules from the main checkout (root-only symlink left `@hono/zod-validator` etc. unresolved). Noted for future worktree verification.

## Done criteria (from spec Success Criteria)  ✅
- [x] Subtitles→time/text, audio→time/single-media, layer toggle, recorder decoupling (structural), `orderedBy` reversible display lens, untimed-flag — all implemented; subtitle + audio paths verified in the running app. (Recorder mic-record and an untimed-row case not driven via UI — covered by code + unit tests.)

**Scope A COMPLETE.** Remaining design decisions for user: (1) toggle kept visible for sequence files (chose not to break audio-Bible editing); (2) transcription/cameraState are create-time only — per-line camera tagging editing deferred to Part B.

---

## Part B (only after Scope A done + no overnight response)
- [ ] Silence-split ingest for audio/video (auto-segment by silence).
- [ ] Speaker diarization → auto-cast on import.
- [ ] (Stretch) waveform snap-and-stretch; combined three-track view.
