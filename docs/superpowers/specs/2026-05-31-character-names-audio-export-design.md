# Character Names, Subtitle Voice Tags & Audio-Export-by-Character — Design

- **Date:** 2026-05-31
- **Status:** Approved (decisions locked); pending written-spec review → implementation plan
- **Source feature:** `~/frontierrnd/codex-editor` (VS Code extension) — `cellLabel`, VTT `<v>` voice tags, FFmpeg audio-export-by-character
- **Target:** `~/prototypes/codex-web-app` (React SPA + Cloudflare Workers / D1 / R2 / Durable Objects)

## 1. Problem & intent

`codex-editor` lets a translator label *who speaks* each subtitle/segment, change that label, and export audio **segregated by character** (one consolidated track per speaker). We are recreating those **outcomes** in the web app — not porting the implementation. The point of this doc is to define each outcome precisely enough to have a real definition of done.

### What "character" means here (the key decision)

In `codex-editor`, a character is just `cell.metadata.cellLabel` — a free-text per-cell string. The web app already has a **richer** concept: a project **Cast** of `Voice` entries (`ProjectTtsSettings.voices`), with lines assigned via `castAssignments: Record<cellId, voiceId>`. A `Voice` only requires a `name` (TTS config is optional), so a Cast member can be a pure named/colored character or a full TTS voice.

**Decision: the Cast is the single source of truth for a cell's character.** A cell's character = `resolveVoiceForCell(cellId, ttsSettings)` ([src/lib/audio/voices.ts:82](../../../src/lib/audio/voices.ts)), i.e. `castAssignments[cellId] → voice`, falling back to `defaultVoiceId`. The character's display name = `voice.name`; its color = `voice.color`. The separate free-text `cellLabel` is **not** the source of truth; it is at most a display fallback (§6).

This reuses the existing picker (`CellVoicePanel`), creator (`voice/CharacterModal.tsx`), and library (`VoiceLibraryPanel`), and — importantly — **syncs**: `ttsSettings` (minus `apiKey`) rides the project-settings channel (`PATCH /api/v2/projects/:id/settings`, top-level-key merge) in [src/lib/sync/project-settings.ts](../../../src/lib/sync/project-settings.ts).

## 2. Locked decisions

| Axis | Decision |
|---|---|
| Character source of truth | **Existing Cast** (`voices` + `castAssignments`); name = `voice.name` |
| Audio output shape | **Concatenated** track per character now; server-side FFmpeg timeline-synced *stems* deferred |
| Audio source per cell | **Best-available**: recording slot (`selectedAudioId`) → generatedVoice slot (`selectedGeneratedVoiceAudioId`) |
| Subtitles | **Full VTT round-trip**: export `<v Name>` cues + import `<v Name>` → Cast |
| Per-cell timecodes | **Proper numeric field** (`start_ms`/`end_ms`) persisted cross-stack (also unblocks deferred FFmpeg stems) |

## 3. Current-state findings (why the work is shaped this way)

- **Cast resolution & sync exist.** `voices.ts` resolves a cell's voice; `ttsSettings` syncs via the settings endpoint (not the per-cell event log). `apiKey` stays local.
- **Two audio slots exist, both readable.** [sync-worker/src/events/cell-audio-read-route.ts:52](../../../sync-worker/src/events/cell-audio-read-route.ts) returns `selectedAudioId` (recording) and `selectedGeneratedVoiceAudioId` (generatedVoice). Bytes are in R2, keyed `projects/{projectId}/files/{fileId}/audio/{audioId}`; fetched today by `useCellAudio.ensureBytes()` ([src/hooks/useCellAudio.ts:139](../../../src/hooks/useCellAudio.ts)).
- **Export plumbing exists.** JSZip is a dep; [src/lib/export/project-zip-export.ts](../../../src/lib/export/project-zip-export.ts) and [src/lib/sync/source-export.ts](../../../src/lib/sync/source-export.ts) already build client-side zips and trigger downloads via `downloadBlob` ([src/lib/export/export-service.ts](../../../src/lib/export/export-service.ts)). No WAV encoder, no VTT exporter, no audio-by-character export.
- **A subtitle importer exists but is lossy.** [src/lib/parsers/subtitle.ts](../../../src/lib/parsers/subtitle.ts) (`extractVttStrings`/`extractSrtStrings`) keeps each cue's timestamp only as a **string in `context`** and does **not** strip/capture `<v Name>` tags.
- **Per-cell timecodes do NOT survive the server model.** `CellRow` ([src/lib/sync/cells-read-types.ts](../../../src/lib/sync/cells-read-types.ts)) has no timing field; [src/hooks/useCells.ts:169](../../../src/hooks/useCells.ts) hardcodes `context: ""`. The D1 `cells` table ([auth-worker/migrations/0006_cells_side_primary_key.sql](../../../auth-worker/migrations/0006_cells_side_primary_key.sql)) has no timing column. So `parseTimestampRange(cell.context)` only works in the original import session. **This is the prerequisite the timing-field slice fixes.**

## 4. Scope

**In scope**

1. **Timecode persistence** — numeric `start_ms`/`end_ms` per cell, through event payload → D1 → read API → client model, and populated on subtitle import.
2. **Audio-export-by-character (concat)** — client-side, best-available audio, one WAV per character, zipped, with a pre-export preview.
3. **VTT round-trip** — export cues wrapped in `<v CastName>`; import `<v Name>` → find-or-create Cast member + assign cell.
4. **Label reconciliation** — the editor shows the *assigned Cast member's* name as the cell's character label.

**Out of scope / deferred** — server-side FFmpeg timeline-synced stems (the "later"); FLAC/Opus output; SRT speaker tags (no native syntax); audio diarization / auto-speaker; changing the existing concurrency semantics of `ttsSettings` writes.

## 5. Architecture & data flow

### Slice A — Timecode persistence (prerequisite for Slice C; independent of Slice B)

Persist numeric timecodes in **milliseconds** end-to-end; expose seconds in the client model (the existing `CodexData.startTime/endTime` and `pair-cells.ts`/`vtt-generator.ts` use seconds).

- **Event payload** — add `startMs?: number`, `endMs?: number` to the cell create/commit input + emitted payload in [src/lib/sync/events-emit.ts](../../../src/lib/sync/events-emit.ts) (alongside the existing `canonicalRef`).
- **D1 migration** — new `auth-worker/migrations/00XX_cell_timecodes.sql`: `ALTER TABLE cells ADD COLUMN start_ms INTEGER; ALTER TABLE cells ADD COLUMN end_ms INTEGER;`
- **Projection** — write `start_ms`/`end_ms` from the payload in [sync-worker/src/events/handlers/cell-events.ts](../../../sync-worker/src/events/handlers/cell-events.ts).
- **Read API** — select + return them in [sync-worker/src/events/cells-read-route.ts](../../../sync-worker/src/events/cells-read-route.ts); add `startMs?: number | null`, `endMs?: number | null` to `CellRow`.
- **Client model** — in `useCells`, map `row.startMs → startTime` (÷1000) and `row.endMs → endTime`; stop hardcoding timing as empty. Keep `context` derivation backward-compatible (derive a display range from start/end when present).
- **Import population** — extend `extractVttStrings`/`extractSrtStrings` to parse the timestamp into numeric start/end, and carry them through [src/lib/import.ts](../../../src/lib/import.ts) → bulk-import so created cells emit `startMs`/`endMs`.

### Slice B — Audio-export-by-character (concat) — *unblocked, no timecode dependency*

New client-side service `src/lib/export/audio-by-character.ts`:

1. **Group** — for each cell, resolve its Cast member via `resolveVoiceForCell`; bucket cells by `voice.id`. Unassigned cells fall to `defaultVoiceId`'s voice, or an "Unassigned" bucket that is excluded from per-character audio.
2. **Select audio** — per cell, best-available: recording slot first, else generatedVoice slot; skip cells with neither.
3. **Fetch** — fetch bytes via a new non-hook util `src/lib/audio/fetch-audio-bytes.ts` (extracted from `useCellAudio.ensureBytes`: resolve `frontier-audio://` → `GET /audio/:projectId/:fileId/:audioId` with sync-token auth).
4. **Decode & normalize** — `AudioContext.decodeAudioData` each clip; resample/downmix to a **common target (48 kHz, mono)** so heterogeneous clips concatenate cleanly; apply non-destructive trim (`trim_start_ms`/`trim_end_ms` from `cell_audio`).
5. **Concatenate** — append per-character buffers in **document order** (anchor-chain order from the cells array).
6. **Encode** — new `src/lib/audio/wav-encode.ts` → `audioBufferToWav(buffer): Blob` (16-bit PCM).
7. **Package** — one WAV per character via JSZip; sanitized filename `{fileBase}_{lang}_{characterKey}.wav`; deliver with `downloadBlob`.
8. **Preview** — pure-data summary (no decode/fetch): per character → clip count, cells-with-audio vs without, total duration estimate, `willExport`. Surfaced in the export UI before the user commits.

**UI** — a workspace **"Export audio by character"** action mirroring the USFM source-export action, plus the preview panel. (Not a row in the text-format `ExportDialog` dropdown, since the output is a zip of audio.)

### Slice C — VTT round-trip (depends on Slice A)

- **Import** ([src/lib/parsers/subtitle.ts](../../../src/lib/parsers/subtitle.ts) + [src/lib/import.ts](../../../src/lib/import.ts)) — extract `<v Name>` via regex (port `extractVoiceLabel` from codex-editor), strip it from the cue text, and surface `speaker` per cue. During import, for each distinct `speaker`: **find-or-create** a `Voice` (name + assigned color, no TTS config) in `ttsSettings.voices` and set `castAssignments[cellId] = voiceId`. Persist all new cast members + assignments in **one** settings PATCH (avoid clobbering).
- **Export** — new `src/lib/export/exporters/vtt.ts`: for each cell with `start_ms`/`end_ms`, emit a cue `HH:MM:SS.mmm --> HH:MM:SS.mmm`. Wrap the text in `<v {escapeVoiceName(castName)}>{text}</v>` **only when the cell has an *explicit* `castAssignments[cellId]`** — a cell that resolves only via `defaultVoiceId` (or not at all) emits **plain text** (matching codex-editor: no voice tag unless actually labeled; the project default does not auto-tag every cue). Cells without timecodes are **skipped and counted** (count surfaced to the user). Port `escapeVoiceName` (strip `<`/`>`, newlines→space, trim) from codex-editor's `vttUtils`. Register `vtt` in the `ExportFormat` union + dispatcher in [src/components/ExportDialog.tsx](../../../src/components/ExportDialog.tsx).

### Reconciliation — show the Cast name as the cell's character label

In [src/components/EditorTable.tsx](../../../src/components/EditorTable.tsx) (~line 1552), compute the displayed label from the cell's **explicitly-assigned** Cast member's `name` (+ color dot), falling back to `cell.cellLabel`, else nothing. (Explicit-only — so a project that never cast its lines doesn't show the narrator on every row.) Keep it behind the existing `cellLabelsEnabled` view toggle.

## 6. Error handling & edge cases

- **No explicit assignment** → *Audio:* resolve via `defaultVoiceId` and group under that voice; if there is no default either, the cell is "Unassigned" and excluded from per-character audio. *VTT / on-screen label:* explicit-only — a default-only or unresolved cell gets plain text (no `<v>`) and no character label (label falls back to `cellLabel`, else nothing).
- **No audio in either slot** → excluded from audio export; counted in preview.
- **No timecodes** → excluded from VTT export; count reported. (Audio concat is unaffected — it uses document order.)
- **Heterogeneous clip formats / sample rates** → normalized to 48 kHz mono before concat; a clip that fails to decode is skipped and reported, not fatal.
- **Bulk cast creation on import** → batch into a single `ttsSettings` write to respect last-writer-wins key merge.
- **Large projects** → decode/concat is memory-heavy; process per character and release buffers; surface progress. (Hard ceilings → the deferred server-side path.)

## 7. Testing strategy (encodes intent, not just mechanics)

- **Unit** — subtitle parser extracts `<v Name>` *and* numeric timecodes, and unwraps cue text; omits speaker when no tag (port codex-editor's two import tests). VTT exporter wraps assigned names, escapes unsafe chars, skips/omits correctly. `audioBufferToWav` emits a valid RIFF/WAVE header and correct sample count. Audio grouping picks best-available and preserves document order.
- **Sync round-trip** (sync-worker test) — a commit carrying `startMs`/`endMs` projects to `cells` and re-reads via the cells route with timing intact (proves the prerequisite).
- **E2E / real-UI walkthrough** (per project convention — drive the actual app): import a `.vtt` with `<v>` tags → Cast members appear, cells assigned, names visible in the editor; run "Export audio by character" → zip contains one WAV per expected character with expected durations/order; export `.vtt` → round-trips names + timings.

## 8. Definition of Done

| Deliverable | Acceptance criteria |
|---|---|
| **Character names visible** | A cell with an explicit Cast assignment renders that member's name + color as its label (under the `cellLabels` toggle); reassigning updates it live; a cell with no explicit assignment shows its `cellLabel` if any, else nothing. |
| **Changing character labels** | `CellVoicePanel` picker reassigns; `CharacterModal` creates/renames a Cast member; the change persists via `castAssignments` and **a second client sees it** after settings sync; renaming a Cast member updates every cell that resolves to it. |
| **Timecode persistence** | A cell's `start_ms`/`end_ms` survive reload and a second client; subtitle import populates them; `useCells` exposes `startTime`/`endTime` in seconds. |
| **Audio-export-by-character** | Export produces a zip with one WAV per character that has ≥1 cell with audio; each WAV = that character's clips concatenated in document order, best-available (recording→generated), trimmed; characters without audio are skipped; filenames sanitized; a preview shows per-character counts/durations before export. *Test:* a 2-character fixture yields 2 WAVs of the expected durations and order. |
| **VTT export + import** | Importing a `.vtt` with `<v Name>` strips the tag, finds-or-creates one Cast member per distinct name, assigns cells, and preserves timecodes; exporting reproduces `<v Name>` cues with correct timings; a full round-trip preserves names + timing; a repeated name reuses one Cast member. |

## 9. Build order & dependencies

- **Slice B (audio export)** and **Slice A (timecodes)** are independent — either can go first / in parallel.
- **Slice C (VTT)** depends on **Slice A**.
- **Reconciliation (§6 label)** is small and independent.

Suggested tracer-bullet order: A → C (the round-trip that needs it) in one track; B in a parallel track; reconciliation folded into whichever touches `EditorTable` first.

## 10. Deferred (explicit "later")

- **Server-side FFmpeg timeline-synced stems** — one full-length track per character with clips placed at `start_ms` over silence (codex-editor's exact FFmpeg outcome). Now unblocked by the persisted timecodes. Needs a Worker-side audio path (FFmpeg is not available in Workers/browser today — likely a separate audio service or container).
- **FLAC/Opus** output; **SRT** speaker handling (no native syntax); **diarization** / automatic speaker assignment.

## 11. Assumptions

- "Character" == Cast member (`Voice.name`); no parallel free-text character concept is introduced.
- First-cut audio export is **client-side WAV**; larger jobs are the deferred server path's job.
- Settings-channel sync of `castAssignments` is acceptable (its last-writer-wins-per-key semantics are pre-existing and unchanged here).
