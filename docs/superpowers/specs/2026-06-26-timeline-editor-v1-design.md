# Timeline Editor (v1) — Design

**Status:** Approved for planning · 2026-06-26
**Driver:** Come and See (The Chosen) dubbing + subtitling; Wendi / Anna
**Parent design:** [2026-06-24-multimedia-timeline-file-design.md](./2026-06-24-multimedia-timeline-file-design.md) — this is the **first slice** of that 5-subsystem vision.

---

## 1. Summary

Make the **Media lens** of a time-ordered file a real horizontal, zoomable, scrollable **timeline editor**: stacked lanes (Subtitle, Dialogue, Untimed), a linked-URL video preview acting as the master clock, click-a-card → bottom detail pane (the existing editor row), and **move + stretch** cards to retime.

The slice is deliberately built **on the existing single-source data model** — no schema change. Subtitle text cells already carry `startMs/endMs`, and media cells (attached audio / diarized segments) carry them too, so we can render both as horizontal lanes today. This becomes the surface that later slices (multi-source lanes, ingest, streaming) plug into.

## 2. Scope

### In scope (v1)
- Horizontal timeline rendering of a time-ordered file in the Media lens: ruler, zoom, horizontal scroll, lanes, playhead.
- Lanes derived from existing cells: **Subtitle** (text cells), **Dialogue** (media cells), **Untimed** tray.
- **Retime**: drag a card to move it; drag its edges to change start/end. Writes via a new `cell.retime` event, optimistic and clock-fenced.
- **Linked-URL video preview** (`react-player`) as the master clock; ruler scrubbing seeks the video.
- **Detail pane**: click a card → bottom pane rendering the existing editor row (source/target, audio, voice, camera).
- Click-to-select, hover affordances, horizontal windowing for long files, read-only/permission handling.

### Explicitly deferred (other slices of the parent design)
- Multi-source-lane schema change (dialogue-source AND subtitle-source as distinct `source` columns, each with a dependent target).
- Ingest split/re-join (Anna's Python), ASR chained onto diarization, AI source-cleanup loop.
- Uploaded-video Range/scrub streaming (linked URL only here).
- Clone-vs-live source links + template/relationship graph.
- Split / merge / create-card-by-drag, drag-from-untimed-tray-to-assign-timing, snapping.
- Synchronized multi-track audio mixdown playback.

## 3. Data model — no schema change

Lanes are **derived** from cells that already exist. Confirmed framing: in v1 the **Dialogue lane is the file's media cells**, not yet a second independent *source* column; the true dialogue-source-vs-subtitle-source split is the later schema slice.

| Lane | Source of cards | Predicate |
|---|---|---|
| **Subtitle** | text cells with timing | `medium !== 'media'` and has `startMs/endMs` |
| **Dialogue** | media cells (attached audio, diarized speaker segments) | `medium === 'media'` |
| **Untimed** | cells with no timing | `startMs == null` |

- Existing fields used: `startMs`/`endMs`, `medium`, `cameraState`, cast/voice, `transcription`, `metadata` (all already projected end-to-end). See `src/lib/parsers/types.ts` (`TranslatableString.medium`, `FileReference.orderedBy`, `fileOrderedBy()`), `src/hooks/useCells.ts` (`buildCellData`), `db/postgres/schema.sql` (cells columns).
- **Core video link:** a per-file `coreMediaUrl` stored in `files.meta` JSON — the same bag that already holds `orderedBy` and languages (`sync-worker/src/events/files-read-route.ts` reads `meta`; `file.create` projection writes `meta`). No new column, no migration.

## 4. Event grammar (two small additions)

The existing grammar (`src/lib/sync/events-emit.ts`, projected in `sync-worker/src/events/event-projection.ts`) has **no timing-update event**: `*.cell.commit` intentionally does not write `start_ms/end_ms` (event-projection.ts ~399), and only `*.cell.create` upserts them. We add:

### 4.1 `cell.retime`
- **Emit:** `emitCellRetime({ fileId, cellId, startMs, endMs })`.
- **Payload:** `{ cellId, fileId, startMs, endMs }`.
- **Projection:** `UPDATE cells SET start_ms = ?, end_ms = ? WHERE project_id = ? AND file_id = ? AND cell_id = ?` — updates **both sides** (source + target) of the cell, because timing is a property of the segment and the two sides must stay aligned.
- **Why a dedicated event:** re-emitting `*.cell.create` would resend `value` and risk clobbering a concurrent content edit; `retime` touches only the two timing columns, which is also conflict-friendly.
- **Optimistic + clock-fenced:** emit through the outbox and hold the dragged position with the existing `writeSeqRef` + per-cell freshness-floor mechanism (AQU-247, `useCells`) so the card does not snap back before the projection read confirms.
- **Permissions:** routed at the same role level as content edits (CONTRIBUTOR); disabled in the UI when the file is read-only/frozen/git-imported.

### 4.2 `file.video.set`
- **Emit:** `emitFileVideoSet({ fileId, coreMediaUrl })` (null clears).
- **Projection:** merge `coreMediaUrl` into `files.meta` JSON (mirrors how `orderedBy` is merged in `file.create`).
- Used by the "Link video" toolbar action and read back by the preview.

## 5. Master-clock playback

> **Superseded 2026-08-08 (AQU-646).** The play queue is the master clock; the
> linked video is a slaved, muted picture surface that follows it. This section
> describes the original arrangement, which shipped and did not work: the video
> and the queue both wrote the timeline clock at ~4Hz with last-writer-wins, the
> video's native play button started picture without sound, and its own
> soundtrack played over the dub. The video now lives beside the text table
> (`MediaVideoPane`) rather than above the lanes, with no native controls, and
> position logic is in `src/components/timeline/video-sync.ts`.
>
> Also corrected in that round: the client had always mapped `coreMediaUrl` off
> the project summary, but the identity worker never sent the field — so §4.2's
> "read back by the preview" was never true and a linked video reached nothing.

- With a `coreMediaUrl` linked, the `react-player` instance is the **master clock**: its progress drives the playhead position; clicking/dragging the ruler calls `seekTo`; cards highlight as the playhead passes.
- Re-enables the currently-disabled video path (`ProjectWorkspace.tsx:962` hardcodes `videoSrc = null`); v1 sources `videoSrc` from the file's `coreMediaUrl` instead.
- With no linked video, the playhead is still a draggable position cursor; **per-card audio playback stays as-is** via the existing `useCellAudio` / `CellWaveform`.
- No synchronized multi-track audio mixdown in v1.

## 6. Components & integration

Hand-rolled over existing primitives (matching `CellWaveform` and `CombinedBoundaryEditor`); only `react-player` (already installed) is used for video. **No new heavy dependency.**

- **`TimelineEditor`** (new) — orchestrates lanes, ruler, playhead, zoom/scroll state, selection, and the preview.
  - `TimelineRuler` — time ticks + scrub target.
  - `TimelineLane` — positions cards by time within one lane (horizontal windowing).
  - `TimelineCard` — pointer-event drag (move) + edge-resize (stretch); emits `cell.retime`.
  - `TimelinePlayhead` — master-clock cursor.
- **Detail pane reuses `EditorRow`.** `EditorRow` is currently a private function inside the ~3k-line `src/components/EditorTable.tsx` (defined ~line 2089). **Targeted refactor:** extract `EditorRow` into its own module so both the vertical table and the timeline detail pane render the identical row surface. No behavioural change to the vertical table.
- **Mount point:** in `EditorTable`, when `isTimeOrdered && audioLens` (Media lens; see `displayCells` ~lines 568-575 and the render loop ~1065), render `<TimelineEditor>` instead of the vertical media list. The Text lens path is untouched. `EditorModeToggle` already relabels Audio→Media for time-ordered files; no toggle change needed.

## 7. Data flow

- **Read:** `useCells` → `CellData[]` → pure `deriveLanes(cells)` (partition by medium + timed/untimed, sort by `startMs`) → render. (Builds on `sortByLens` in `src/lib/timeline/derive.ts`.)
- **Zoom/scroll:** local component state (`pixelsPerSecond`, `scrollLeft`); persist zoom in `localStorage` (same pattern as `useEditorLensPreference`).
- **Write (retime):** pointer drag → px→ms conversion → optimistic clock-fenced local update → `emitCellRetime` → outbox flush → projection → `revalidateCells`.
- **Selection:** local `selectedCellId` drives card highlight + the detail pane.
- **Windowing:** render only cards whose time range intersects the visible window (`scrollLeft` + viewport width ÷ `pixelsPerSecond`), mirroring the vertical virtualizer's intent — important for episodes with hundreds of cues.

## 8. Edge cases & failure modes

- **Read-only / frozen / git-imported file** → drag/resize disabled; timeline is view-only.
- **Overlapping cards within a lane** → allowed; hover raises z-order. No ripple or auto-resolve.
- **Concurrent edits** → retime goes through the existing cell claim / focus-lock path, same as content edits.
- **Degenerate drags** → clamp `endMs > startMs` with a minimum duration; reject NaN/negative.
- **No `coreMediaUrl`** → preview shows an empty state with a "Link video" CTA; the timeline remains fully usable. *(2026-08-08: there is no preview above the lanes any more — with no linked video the pane simply does not mount, and "Link video" lives in the toolbar. See the note in §5.)*
- **Untimed tray** → view + select only in v1 (drag-to-assign-timing deferred).
- **Empty media lane** → existing "No media segments yet" / `TimelineAddMedia` empty state is preserved.

## 9. Testing (intent-encoding)

- **Pure functions:** time↔px mapping; `deriveLanes` partition + sort; retime payload + clamp; windowing selection.
- **Event layer:** `emitCellRetime` emits the expected payload; projection updates **both** source and target rows; the clock-fence keeps the optimistic position across a projection round-trip.
- **Component:** dragging a card emits `cell.retime` with the expected `startMs/endMs`; edge-resize changes only the dragged bound; selection populates the detail pane; read-only disables drag.
- **e2e (verify-dev-change / Showcase harness):** open a subtitle file → Media lens → see Subtitle + Dialogue lanes → drag a clip → reload → timing persisted in the projection.

## 10. Confirmed decisions

1. Dialogue lane = the file's **media cells** in v1; the true dialogue-source/subtitle-source split is a later slice.
2. `cell.retime` updates **both** source and target rows (timing is segment-level).
3. The **Media lens *is* the timeline view** (replaces the vertical media list); the Text lens is unchanged.
4. Two small grammar additions: **`cell.retime`** and **`file.video.set`** (`coreMediaUrl` in `files.meta`).
5. The **Untimed tray is view/select-only** in v1.
6. **Extract `EditorRow`** from `EditorTable.tsx` into its own module for reuse by the detail pane.

## 11. Key integration points (for the implementer)

- `src/components/EditorTable.tsx` — `displayCells` medium filter + `sortByLens` (~568-575), virtual render loop (~1065), media empty state / `TimelineAddMedia` (~1179), `EditorRow` (~2089, to extract).
- `src/components/ProjectWorkspace.tsx` — disabled video (`videoSrc = null`, ~962), `EditorModeToggle` mount (~3356), `EditorTable` mount + `orderedBy` thread (~3611/3628), `attachMediaUrlToTimeline` handler (~943).
- `src/lib/sync/events-emit.ts` — emit functions (add `emitCellRetime`, `emitFileVideoSet`).
- `sync-worker/src/events/event-projection.ts` — add `cell.retime` and `file.video.set` cases; cell.create timing upsert (~207-208/335-336), commit-skips-timing (~399) for reference.
- `sync-worker/src/events/files-read-route.ts` — `meta` JSON read (~63-79) to surface `coreMediaUrl`.
- `src/lib/timeline/derive.ts` — `sortByLens` (~96-127) to extend with `deriveLanes`.
- `src/hooks/useCells.ts` — `buildCellData` (~93-108/182-229) and the AQU-247 write-clock fence.
- Primitives to reuse: `src/components/CellWaveform.tsx`, `src/components/voice/CombinedBoundaryEditor.tsx`, `react-player`.
