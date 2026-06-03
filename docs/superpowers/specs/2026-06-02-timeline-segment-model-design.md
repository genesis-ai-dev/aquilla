# Timeline-Anchored Segment Model — Design (Scope A)

**Date:** 2026-06-02
**Status:** Approved for implementation (Scope A / Part A)
**App:** Aquilla (codex-web-app)

## Problem

Subtitle timing and audio/dub timing are two fundamentally different tracks
that cannot share timestamps:

- **Subtitles** are constrained by reading speed and screen real estate
  (~35–40 chars/line). Text is condensed; some lines are dropped entirely;
  timing is tuned to how fast a viewer reads.
- **Audio/dub** is constrained by the speaker's mouth and the camera state
  (on / mixed / off). Text can say more; timing is locked to the source
  waveform, not to reading speed.

Today the editor **couples** them: a single cell carries the subtitle
`startMs/endMs` *and* its audio attachments, and the recorder derives its
target duration directly from the subtitle window
(`activeCell.endTime - activeCell.startTime`). This forces recorded audio to
wear the subtitle's clock — the exact problem Come-and-See's Wendi identified.

These two also map to Codex's two historically-separate import workflows:

- **subtitle-import → translation** (VTT/SRT → timed text cells)
- **audio-import → transcription** (audio → silence-split clips → ASR → target)

## Core Model

> A file has a **timeline** as its potential spine. On it sit **segments**.
> Every segment always has a **sequence order**; it *optionally* has **timing**.
> Beyond that a segment can independently carry source text, target text, a
> transcription, a camera state, and audio take(s). **Association between any
> two segments is computed live from timing overlap — never stored.**

Two ideas were explicitly rejected during design and must NOT be reintroduced:

1. **No stored link between segments** (no `sourceLineId`, no "unlinked"
   state). Overlap is recomputed from timecodes on every render. There is
   nothing to maintain and nothing that can drift or lie.
2. **No synthesized or destroyed timing.** Converting a file between order
   modes never invents or deletes timecodes. Missing timing is *flagged*,
   never faked.

### `orderedBy` is a display lens, not a data transform

`orderedBy: 'time' | 'sequence'` lives on the **file** and selects which key
is authoritative for ordering and which data is emphasized. Because every
segment always carries `sequenceIndex` and *may* carry timing, toggling
`orderedBy` changes only the sort key and presentation — **the stored bytes
never change.** Therefore the toggle is fully reversible, both directions,
with zero data loss.

- `'sequence'`: rows sort by `sequenceIndex` (intrinsic order, e.g. verse
  order). Timing is metadata. This is today's behavior and the default.
- `'time'`: rows sort by timing start, with `sequenceIndex` as the tiebreak
  *and* as the home position for segments that have no timing. The timeline
  spans the **fullest range** of timed segments — `min(start) → max(end)` —
  computed on read.

Subtitles are the proof case: they are sequence-based *and* timed, and their
order corresponds to time because time produced the order.

### `medium` distinguishes content kind

`medium: 'text' | 'media'` lives on the **segment**:

- `'text'`: primary content is source/target text (today's subtitle and verse
  cells). Default for all existing cells.
- `'media'`: primary content is an audio/video clip plus a **transcription**
  (correctable, free to diverge from any target text) and a **camera state**.

Both kinds may *also* carry the other's data — a text cell can have a recorded
take (today's behavior, unchanged); a media cell can hold target text.
`medium` does real work that presence-of-data cannot infer: it selects which
editor layer the segment appears in, and which timing discipline the recorder
applies. It is **not** derivable from whether audio/text happens to be present.

## Data Model Changes

All changes are **additive** with safe defaults. No production data exists yet
(prototype mode), so "migration" = defaults applied to dev/seed data, not a
backward-compat path.

### File level — `FileReference` (`src/lib/parsers/types.ts`)

```ts
orderedBy?: 'time' | 'sequence'   // default 'sequence' when absent
```

Drives a distinct **file-list icon** per value (timeline/waveform glyph for
`'time'`, stacked-rows glyph for `'sequence'`).

### Segment level — `CellRow` (server projection) + `CellData` (editor)

```ts
// CellRow (src/lib/sync/cells-read-types.ts) and surfaced on CellData:
sequenceIndex?: number              // intrinsic order; fractional ranks allowed for in-between inserts
medium?: 'text' | 'media'           // default 'text'
transcription?: string              // ASR / corrected source text for a media clip
cameraState?: 'on' | 'mixed' | 'off'  // unset by default
```

Reused, NOT reinvented:

- Timing already exists: `startMs/endMs` (`CellRow`) ↔ `startTime/endTime`
  (`CellData`). Media segments use these as their spine. No new timing fields.
- Audio takes already exist: `AudioAttachmentOut` / `CellAudioEntry`. A media
  segment's clip is just an attachment on that segment. No parallel store.
- Cast/voices, `castAssignments`, validation status — unchanged; work on any
  segment.

### Ordering / inserts

`sequenceIndex` must permit insertion *between* two existing segments (e.g. an
audio-only row at 0:08 landing between sequence #5 and #6). Use **fractional
ranks** (e.g. midpoint between neighbors) or renumber-on-insert. Decide and
document in the implementation plan; do not discover it late.

## Derived (read-time) helpers

- **Timeline bounds**: `min(start)`, `max(end)` over segments with timing.
- **Overlap / association**: given a segment, the set of other-medium segments
  whose `[start,end]` intersects it. Advisory only; recomputed each render.
- Both live as pure functions over the cell array (alongside `useCells`),
  never persisted.

## Unified Import & Setup

One **ingest entry** replaces the two unrelated import paths. "What are you
starting from?" sets the new file's `orderedBy` and the `medium` of its
initial segments:

| Route | `orderedBy` | initial `medium` | Notes |
|-------|-------------|------------------|-------|
| Subtitles (VTT/SRT) | `time` | `text` | Today's `extractVttStrings` path; keep speakers→cast import. |
| Audio file | `time` | `media` | **Scope A: land as a single media segment** spanning the file; user splits manually. Silence-split deferred to Part B. |
| Video file | `time` | `media` | Same as audio; video becomes the timeline backdrop. Transcription empty (ASR later). |
| Text (USFM/eBible/docx) | `sequence` | `text` | Today's behavior, untouched. |

No new *project* type — `orderedBy` is per-file, so one project freely mixes a
time-ordered episode and a sequence-ordered book.

## Editor View

- The existing **text↔audio toggle becomes a `medium` layer switch**, shown
  **only when `orderedBy === 'time'`**:
  - **Text layer**: `text` segments, reading-timed rows (edit as today).
  - **Media layer**: `media` segments, each with its own timing, camera tag,
    transcription, and take(s).
- **Sequence-ordered files render exactly as today** — no layer switch, verse
  rows, audio-as-attachment. The audio-Bible / text-translation experience is
  byte-for-byte unchanged.
- **Recorder decoupling (the core fix)**: in a `'time'` file, the recorder's
  target window comes from the **media segment's own timing**, never from a
  subtitle's window. In `'sequence'` files, recording stays attachment-on-cell.
- **Advisory overlap**: a media row may show "overlaps S1, S2" as a peek
  (click to view the text), recomputed from timecodes. No stored link.
- **Camera state**: inline `on / mixed / off` control on media rows.
- **Honest flags (per "fail loud"):**
  - Untimed segments in the time lens render with a distinct "no specific
    timing" treatment (e.g. dashed/ghost row), kept in `sequenceIndex` order.
  - When the time lens and sequence lens would order rows differently, surface
    a subtle indicator so toggling isn't startling.

## Sync / Events (v3 D1 event log)

Per project memory: D1 is the single source of truth; ProjectSync DO handles
presence + focus-locks; no Yjs. This feature adds **no new event types and no
new DO**:

- New segment fields (`sequenceIndex`, `medium`, `transcription`,
  `cameraState`) ride existing `cell.create` / `cell.commit` event payloads
  and the cells projection.
- New file field (`orderedBy`) rides the existing file event/projection.

## Build Sequence (tracer-bullet order)

1. **Schema + defaults.** Add `orderedBy` to `FileReference`; add `medium`,
   `sequenceIndex`, `transcription`, `cameraState` to `CellRow`/`CellData` and
   the projection. Apply defaults (`'sequence'` / `'text'`) to seed data.
2. **Read path.** `useCells` surfaces the new fields; add derived helpers for
   timeline bounds + overlap (pure functions over the cell array).
3. **Lens toggle.** Make the editor's text/audio toggle a `medium` layer
   switch gated on `orderedBy === 'time'`; render media-layer rows
   (timing/camera/transcription). Add file-list icons per `orderedBy`.
4. **Recorder decoupling.** Target window from the media segment's own timing.
5. **Unified import.** Ingest picker → four routes; audio/video lands a single
   media segment (Scope A "B-option").
6. **Verify in the real UI** via the `verify-dev-change` workflow.

## Explicitly Out of Scope A (→ Part B)

- Silence-split ingest (auto-segment audio by silence).
- Speaker diarization → auto-cast on import.
- Waveform **snap-and-stretch** (snap take to English start, stretch/shrink to
  match duration, native-speaker sanity check, optional speech-to-speech).
- Combined "all three at once" view (source audio / target audio /
  transcription stacked on one spine).

## Success Criteria

- A VTT import produces a `time`-ordered file of `text` segments; an audio
  import produces a `time`-ordered file with one `media` segment; a USFM import
  is unchanged (`sequence` / `text`).
- In a `time` file, the editor toggles between a text layer and a media layer;
  recording on a media segment uses *that segment's* timing as the target.
- Toggling `orderedBy` on a file changes only ordering/presentation — verified
  no cell bytes change.
- Untimed segments in the time lens are visibly flagged, not assigned fake
  timecodes.
- Existing sequence/text projects render and record exactly as before.
- `pnpm typecheck` / lint / existing tests pass; change verified in the running
  app.
