# Media-View Audio-First Detail Pane — Design

**Status:** Approved for planning · 2026-07-01
**Driver:** Ryder — dubbing workflow (listen to the original clip, record the dub) for Dialogue-lane cards in the Media lens
**Parent design:** [2026-06-26-timeline-editor-v1-design.md](./2026-06-26-timeline-editor-v1-design.md) — this extends v1's "detail pane reuses `EditorRow`" decision (§6, §10.6) with a second, audio-first rendering mode for that same reused row.
**Related, in-flight (not a dependency):** `2026-06-27-multi-source-tracks-design.md` (read 2026-07-01 from a sibling worktree — see §2, §8 corrections below). Its `track_id` mechanism is a **lane-grouping** partition (Dialogue vs. Subtitle tracks, each still pairing source↔target via today's unchanged `(cell_id, side)` model — its own confirmed decision #2: "not a new pairing axis"). It does **not** define what counts as source vs. target audio, so it doesn't supersede this spec's mechanism — see the corrected reasoning below.

---

## 1. Summary

Today, selecting any card in the Media lens's timeline detail pane renders the full text-oriented `EditorRow` — a text SOURCE box, an editable TARGET textarea, and the Staleness / Back-translation / Recording / Issues / History tabs (shipped 2026-07-01, same-day predecessor to this spec: `EditorTable` gained `hideHeader` + `expandRowsByDefault`, `TimelineEditor` gained a `renderDetail` render prop, `ProjectWorkspace` wires a single-cell `EditorTable` instance into it).

This spec adds a **second mode** for that same detail-pane row: when the selected card is a Dialogue-lane cell (`medium === "media"`) **and** the file has a linked `coreMediaUrl`, the row's primary content becomes **source audio (left) / target audio (right)** instead of text boxes — because for a dubbing workflow, the thing a translator needs to do is *listen* to the original line and *record* their language's line, not type. The tabs below are unchanged and reused as-is.

## 2. Scope

### In scope
- A new optional `EditorRow` prop carrying a resolved `{ url, startSec?, endSec? }` window. When present and the cell's `medium === "media"`, `EditorRow` renders the audio-first primary section instead of the text grid.
- A new, independent trimmed-clip player (hook + small presentational component) that points a media element directly at `coreMediaUrl` and auto-bounds playback to `[startSec, endSec]`.
- Wiring only through the Media-view's single-cell `EditorTable` instance (`ProjectWorkspace`'s `renderDetail` closure, `ProjectWorkspace.tsx:3752`) — the closure already has `activeFile.coreMediaUrl` in scope, so no `TimelineEditor` prop-signature change is needed beyond the `renderDetail` render prop already shipped.
- Captions: source shows `cell.transcription || cell.original` read-only under the player; target shows the existing editable translated-text textarea under the recorder (the same component, relocated — not reimplemented).
- Mutual-exclusion guard: starting either player pauses the other.
- Fallback: if `coreMediaUrl` is absent, or the cell isn't `medium === "media"`, the pane renders exactly today's shipped text-first row — unchanged.

### Explicitly deferred
- **`track_id` (corrected 2026-07-01 after reading the actual spec):** the in-flight multi-source-tracks effort adds `cells.metadata.trackId` purely as a **named-lane partition** — e.g. grouping a file's cells into a "Dialogue" lane and a "Subtitle" lane — with source↔target pairing *within* a track still going through today's unchanged `(cell_id, side)` model (that spec's own confirmed decision #2: "not a new pairing axis," no separate source-track/target-track entity). It is **not** the "source vs. target audio" abstraction this spec initially assumed it would be, and it adds no audio-attachment capability to a cell's source row. So it doesn't supersede or get superseded by the mechanism here — they're orthogonal. The one place multi-source-tracks *does* touch this feature: today's Dialogue-lane gate (`cell.medium === "media"`) is a medium-based heuristic that stays valid for untracked files (that spec's own fallback), but once a file adopts named tracks, lane membership becomes `trackId`-based — this feature's gate may need to also check the cell's resolved track (or its `TrackDef.medium` hint) at that point. That's a narrow follow-up when tracked files exist, not a redesign of this feature. The actual open question this spec doesn't answer — "does a cell's *source* row ever carry its own audio attachment, instead of deriving playback from the file's linked media?" — is untouched by either spec; if that capability is ever added, the trimmed-clip hook (§4) is the one seam that would change.
- Waveform/peaks for the source clip (decoding peaks from an arbitrary linked video per segment is real cost for little payoff at this scale) — a plain progress bar is enough for v1. The target side keeps its existing waveform (`CellWaveform`, already peaks-capable) since that machinery is unchanged.
- Applying this layout to the dense Text-lens table for `medium === "media"` rows. Confirmed 2026-07-01: scoped to the Media-view detail pane only. The Text lens is unaffected — it doesn't pass the new prop.
- Auto-chaining (e.g., auto-play source → auto-arm recording). Two independent controls for v1.
- Removing the "Recording" tab. Confirmed 2026-07-01: it stays (denoise/transcribe/re-record still live there), even though play/record now also appears in the primary panel.

## 3. Data model — no schema change

No new persisted field, attachment type, or event. The source side is **derived**, not stored:

- `coreMediaUrl` — already a per-file field in `files.meta` (see parent spec §3, §4.2); unchanged.
- `cell.startTime` / `cell.endTime` — already derived from `startMs`/`endMs` in `buildCellData` (`src/hooks/useCells.ts`); unchanged.
- The new `{ url, startSec, endSec }` window passed into `EditorRow` is computed in the `ProjectWorkspace` render closure from those two existing values — not persisted anywhere.

This is intentionally the minimal, schema-free approach: it adds nothing that would need a migration or a follow-up cleanup regardless of how the multi-source-tracks lane-grouping mechanism evolves (see §2's corrected note — that work doesn't redefine source vs. target audio, so there's no near-term model it needs to reconcile with).

## 4. Components

- **`useTrimmedFileAudio(url: string | null, startSec: number | undefined, endSec: number | undefined)`** (new hook). Owns a media element pointed at `url`; on mount/when `startSec` changes, seeks there; exposes `play()`/`pause()`/`isPlaying`/`currentTime`/`error`; on `timeupdate`, if `currentTime >= endSec`, pauses and resets to `startSec` (same shape as `useCellAudio`'s existing trim-then-autopause behavior at `src/hooks/useCellAudio.ts:336-345`, but independent — this isn't a cell attachment fetched through IDB/R2, it's the file's already-public linked URL). This hook is the seam that would change **if** a future, currently-unscoped effort adds a real per-cell source-side audio attachment (the multi-source-tracks work does not — see §2's corrected note); until then, this derivation may simply be the durable mechanism, not a stopgap.
- **A small presentational player** (new, e.g. `SourceClipPlayer`) — play/pause button + a slim progress bar scaled to `[startSec, endSec]`, using the hook above. On load failure, shows an inline "Couldn't load the source clip" message.
- **Target side — reused as-is, not reimplemented:** `useCellAudio`, `CellAudioButton`, `CellWaveform`, and the existing record/re-record flow, currently assembled inline in `EditorRow`'s "Recording" tab content (`src/components/EditorTable.tsx` — target column at `~3212`) and Recording tab (per prior session's exploration). The audio-first primary section calls the same hook/components the row already constructs for the Recording tab; it does not duplicate their logic.
- **`EditorRow`** (`src/components/EditorTable.tsx:2029`) — gains the new optional prop. The branch sits where the row currently starts its primary Source/Target grid (Source column `~3113`, Target column `~3212`): when the new prop is present and `cell.medium === "media"`, render the audio-first header there instead. The row falls through to the **same** `<CellExpansion>` mount (`~3676`) with the same `tabs` array unchanged — `CellExpansion` is already a decoupled tab-shell that takes pre-built tab content, so branching only the primary section (not the tabs) keeps this a narrow, additive change rather than a rewrite.
- Threading: `EditorTable` gets one new optional prop (name TBD at plan time, e.g. `mediaSourceClip?: { url: string; startSec?: number; endSec?: number }`), passed down to `MemoizedRow` → `EditorRow`, following the exact same additive-prop pattern already used for `expandByDefault` (`EditorTable.tsx:495, 531, 1189, 1320, 1360, 1504, 1612, 2061, 2723, 2726`).

## 5. Data flow

- `ProjectWorkspace`'s `renderDetail` closure (`ProjectWorkspace.tsx:3752`) already has `activeFile.coreMediaUrl` and the selected/enriched cell in scope.
- It computes `mediaSourceClip = cell.medium === "media" && activeFile.coreMediaUrl ? { url: activeFile.coreMediaUrl, startSec: cell.startTime, endSec: cell.endTime } : undefined` and passes it to the single-cell `<EditorTable>` instance alongside the already-shipped `hideHeader` / `expandRowsByDefault` (`ProjectWorkspace.tsx:3766-3769`).
- `EditorTable` → `MemoizedRow` → `EditorRow` threads it through unchanged (no per-row computation needed — there's exactly one row in this instance).
- `EditorRow` reads the prop once at render time to decide which primary section to render; no new state beyond what `useTrimmedFileAudio` and the existing target-audio hooks already own.
- **Mutual exclusion:** when the source player's `play()` is invoked, call `pause()` on the target controller (and vice versa) — a two-call guard at the point where each player's play button fires, not a new coordinating state machine.

## 6. Edge cases & failure modes

- **No `coreMediaUrl` on the file** → `mediaSourceClip` is `undefined` → today's text-first row, unaffected. No empty/prompt state needed for the audio panel because the panel never mounts in this case.
- **`medium !== "media"`** (Subtitle-lane or Untimed cell selected) → same fallback, regardless of whether a video happens to be linked.
- **Cell is missing `startTime` or `endTime`** (either one, not just both — e.g. an untimed Dialogue cell, if that ever occurs) → the trimmed player has nothing to bound playback to. Treat as the no-clip fallback (render text-first) rather than playing the linked file unbounded from an arbitrary point — a translator selecting one untimed dialogue line should not get an unbounded stretch of the episode's audio.
- **Source clip fails to load** (404, network error) → inline "Couldn't load the source clip" message; target side is unaffected and still usable.
- **Overlapping play — source vs. target** (user starts target recording/playback while the segment source clip is still playing, or vice versa) → the mutual-exclusion guard in §5 stops the other side first.
- **Overlapping play — segment clip vs. top-of-pane full-file preview:** `TimelineEditor`'s existing whole-file `<video>` preview (`coreMediaUrl` played via `videoRef`, top of the pane) and this feature's segment `useTrimmedFileAudio` element are intentionally independent (§4 — kept decoupled from `TimelineEditor` internals to avoid coupling this feature to the master clock). If a user has the full preview playing and also plays a segment clip, both point at the same file and can sound overlapped/echoed. **Accepted limitation for v1** — not coordinated, since doing so would mean threading a shared ref/pause-callback into `renderDetail` and re-coupling to `TimelineEditor`'s master clock, which this design deliberately avoided for simplicity. Revisit if it proves annoying in practice.
- **Read-only / frozen / git-imported file** → unchanged from today: the target recorder/textarea already respect `editable`; this spec doesn't add any new write path beyond what `EditorRow` already gates.

## 7. Testing (intent-encoding)

- **`useTrimmedFileAudio`:** seeks to `startSec` on mount and whenever the cell (hence the window) changes; auto-pauses and resets to `startSec` once `currentTime` reaches `endSec`; surfaces a load error.
- **`EditorRow` branching:** given `mediaSourceClip` + `cell.medium === "media"`, renders the audio-first header (source player + caption, target recorder + textarea) instead of the text grid, with the same tab set below; given no `mediaSourceClip` (today's main Text-lens call site, and any Media-view case where the fallback conditions apply), renders exactly today's row — this should not regress the existing `EditorTable`/`EditorRow` test suite.
- **Mutual exclusion:** starting source playback while target is playing pauses target, and vice versa.
- **Browser verification (`verify-dev-change`):** open `come-and-see.vtt` (or an equivalent Dialogue-lane fixture) with no linked video → confirm the pane still shows today's text-first row (fallback path exercised). Link a video via the toolbar → select a Dialogue card → confirm the audio-first header appears, play/pause both sides, confirm mutual exclusion, confirm the tabs below still work (spot-check at least the Recording tab, since it's now visually redundant with the primary panel but intentionally kept per §2).

## 8. Confirmed decisions

1. Source audio = a trimmed clip of the file's already-linked `coreMediaUrl`, bounded by the cell's own `startTime`/`endTime` — no new schema, no new attachment type. Initially framed as an interim pending the in-flight `track_id` work; corrected 2026-07-01 after reading that spec — it's a lane-grouping mechanism (Dialogue vs. Subtitle tracks), not a source/target audio model, so it doesn't supersede this. This derivation is isolated behind one hook (`useTrimmedFileAudio`) regardless, so it stays swappable if a genuinely different future effort ever adds per-cell source-side audio attachments.
2. Scoped to the Media-view detail pane only — the Text lens keeps its current row rendering for every cell, including Dialogue-medium ones, unchanged.
3. Text stays visible as captions under each player (source: read-only transcription/original; target: the existing editable textarea), not audio-only.
4. The "Recording" tab stays, even though it's now redundant with the primary panel's play/record controls, so denoise/transcribe/re-record remain reachable.
5. Fallback to today's shipped text-first row whenever there's no linked video or the cell isn't a Dialogue-medium timed cell — no separate empty/prompt state to design or maintain.

## 9. Key integration points (for the implementer)

- `src/components/EditorTable.tsx` — `EditorRow` (`2029`); Source column (`~3113`) and Target column (`~3212`) are where the new branch inserts; `<CellExpansion>` mount (`~3676`) is reused unchanged; existing additive-prop pattern to follow: `hideHeader`/`expandRowsByDefault`/`expandByDefault` threading (`491, 495, 530-531, 1036, 1189, 1266, 1320, 1360, 1504, 1575, 1612, 2061, 2723, 2726`).
- `src/components/timeline/TimelineEditor.tsx` — `renderDetail` render prop (`34, 68, 225-227`), already shipped; no changes needed here for this spec.
- `src/components/ProjectWorkspace.tsx` — `commonEditorTableProps` (`3144`) and the `renderDetail` closure for the Media-view single-cell `EditorTable` (`3752, 3766-3769`) — this is where `mediaSourceClip` gets computed and passed.
- `src/hooks/useCellAudio.ts` — trim-then-autopause reference implementation (`336-345`) to mirror (not call into) for the new `useTrimmedFileAudio` hook.
- New files (naming/location to be finalized in the implementation plan): the trimmed-clip hook and its presentational player — likely alongside the timeline components (`src/components/timeline/`) or the cell-audio components (`src/components/`), matching whichever existing convention the plan settles on.
- `docs/superpowers/specs/2026-06-27-multi-source-tracks-design.md` (sibling worktree as of 2026-07-01, not yet merged) — read for the `track_id` correction above; re-check its status before implementing this spec's `cell.medium === "media"` gate, in case tracked files already exist by then.
