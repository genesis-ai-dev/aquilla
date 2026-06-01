# Subtitle Voice-Tag Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Round-trip subtitle speakers through the Cast: (a) IMPORT — parse `<v Name>` voice tags from VTT cues, strip them from the text, and find-or-create a Cast member per distinct name + assign the cell; (b) EXPORT — a `.vtt` exporter that wraps each timed cell's text in `<v CastName>` for explicitly-cast cells; (c) RECONCILE — show the explicitly-assigned cast member's name as the cell's on-screen label.

**Architecture:** A ported, pure `extractVoiceLabel` + `escapeVoiceName` (from codex-editor). The subtitle parser gains a `speaker` field on each cue; the import orchestrator collects distinct speakers, mints one `Voice` per new name (palette color), and persists voices + `castAssignments` in one batched `saveTts` write. A new `exportVtt(cells, settings)` exporter reuses the now-persisted `startTime`/`endTime` (from the timecode plan) and resolves the explicit cast name. The editor label reads `assignedCastVoiceId`.

**Tech Stack:** TypeScript, React, vitest (happy-dom).

**Depends on:** `cell-timecode-persistence` (VTT export needs `startTime`/`endTime` to survive reload). Do that plan first.

---

### Spec reference
`docs/superpowers/specs/2026-05-31-character-names-audio-export-design.md` §5 "Slice C" + "Reconciliation". Rule: **explicit** `castAssignments[cellId]` drives the on-screen label and the `<v>` tag (no tag for default-only/unassigned cells); this matches codex-editor.

### Reusable pieces (already exist)
- `assignedCastVoiceId(settings, cellId)` → explicit voiceId or undefined — `src/lib/audio/voices.ts`
- `resolveCastVoice(settings, cellId, cellVoiceId)` → `Voice` — `src/lib/audio/voices.ts`
- `VOICE_PALETTE` (12 hex colors) — `src/lib/audio/voices.ts`
- `formatVttTime` / `parseTimestampRange` — `src/lib/video/vtt-generator.ts` (exported `parseTimestampRange`)
- `useProjectTts().saveTts(overrides)` and `.assignCells(cellIds, voiceId)` — `src/hooks/useProjectTts.ts`
- `uuidv7` (id minting) — same util `src/lib/import.ts` uses

### File map
- Create: `src/lib/export/vtt-voice.ts` (`escapeVoiceName`, `extractVoiceLabel`) + test
- Modify: `src/lib/parsers/types.ts` (`TranslatableString.speaker?`)
- Modify: `src/lib/parsers/subtitle.ts` (strip `<v>` → `speaker`)
- Modify: `src/lib/parsers/subtitle.timecodes.test.ts` (or add a sibling test for speakers)
- Create: `src/lib/import/cast-from-speakers.ts` (pure: speakers → new voices + assignments) + test
- Modify: import orchestrator (`src/lib/import.ts` / `src/components/ImportDialog.tsx`) to apply cast additions
- Create: `src/lib/export/exporters/vtt.ts` + test
- Modify: `src/components/ExportDialog.tsx` (register `vtt` format)
- Modify: `src/components/EditorTable.tsx` (label = explicit cast name → fallback cellLabel)
- Create: `e2e/subtitle-voice-roundtrip.spec.ts`

---

### Task 1: Port `escapeVoiceName` + `extractVoiceLabel` (pure)

**Files:**
- Create: `src/lib/export/vtt-voice.ts`
- Test: `src/lib/export/vtt-voice.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { escapeVoiceName, extractVoiceLabel } from "./vtt-voice"

describe("escapeVoiceName", () => {
  it("strips <,> and collapses newlines", () => {
    expect(escapeVoiceName("Ma<ry>\nJane")).toBe("Mary Jane")
  })
})

describe("extractVoiceLabel", () => {
  it("pulls a <v Speaker>...</v> span into speaker + unwrapped text", () => {
    expect(extractVoiceLabel("<v Narrator>Hello there</v>")).toEqual({ speaker: "Narrator", text: "Hello there" })
  })
  it("supports open-ended <v Speaker>... without closing tag", () => {
    expect(extractVoiceLabel("<v Mary>Hi")).toEqual({ speaker: "Mary", text: "Hi" })
  })
  it("returns null speaker and original text when no voice tag", () => {
    expect(extractVoiceLabel("Just text")).toEqual({ speaker: null, text: "Just text" })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export/vtt-voice.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (ported from codex-editor `vttUtils.ts` + subtitles importer)**

```typescript
// src/lib/export/vtt-voice.ts
// Ported from codex-editor: src/exportHandler/vttUtils.ts (escapeVoiceName) and
// webviews/.../NewSourceUploader/importers/subtitles/index.ts (extractVoiceLabel).

/** Sanitize a name for use inside a WebVTT <v ...> voice tag. The annotation
 *  portion cannot contain `<`, `>`, or newlines. */
export function escapeVoiceName(label: string): string {
  return label.replace(/[<>]/g, "").replace(/\r?\n/g, " ").trim()
}

const VOICE_TAG_RE = /^\s*<v(?:\.[^>\s]+)*\s+([^>]+)>([\s\S]*?)(?:<\/v>\s*)?$/

/** Pull a leading `<v speaker>...</v>` (or open-ended `<v speaker>...`) off a
 *  cue payload. Returns { speaker: null, text } when no voice tag is present. */
export function extractVoiceLabel(cueText: string): { speaker: string | null; text: string } {
  const match = cueText.match(VOICE_TAG_RE)
  if (!match) return { speaker: null, text: cueText }
  const speaker = match[1].trim()
  const inner = match[2]
  return speaker.length > 0 ? { speaker, text: inner } : { speaker: null, text: cueText }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export/vtt-voice.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/export/vtt-voice.ts src/lib/export/vtt-voice.test.ts
git commit -m "feat(subtitles): port VTT voice-tag escape + extract helpers"
```

---

### Task 2: Parser — strip `<v Name>` into `speaker`

**Files:**
- Modify: `src/lib/parsers/types.ts` (`TranslatableString.speaker?`)
- Modify: `src/lib/parsers/subtitle.ts`
- Test: `src/lib/parsers/subtitle.speaker.test.ts`

- [ ] **Step 1: Add `speaker` to `TranslatableString`**

In `src/lib/parsers/types.ts`, inside `interface TranslatableString` (near `start`/`end` from the timecode plan):

```typescript
  /** Speaker extracted from a `<v Name>` VTT voice tag, if present. Maps to a
   *  Cast member on import. */
  speaker?: string
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/parsers/subtitle.speaker.test.ts`:

```typescript
import { describe, it, expect } from "vitest"
import { extractVttStrings } from "./subtitle"

describe("extractVttStrings voice tags", () => {
  it("extracts <v Name> into speaker and unwraps the cue text", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n<v Narrator>Hello there</v>\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.speaker).toBe("Narrator")
    expect(cue.original).toBe("Hello there")
  })

  it("leaves speaker undefined when no voice tag", () => {
    const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nPlain line\n"
    const [cue] = extractVttStrings(vtt)
    expect(cue.speaker).toBeUndefined()
    expect(cue.original).toBe("Plain line")
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/parsers/subtitle.speaker.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement in `extractVttStrings`**

In `src/lib/parsers/subtitle.ts`, import the helper at the top:

```typescript
import { extractVoiceLabel } from "@/lib/export/vtt-voice"
```

In the `flush()` inside `extractVttStrings`, after building `const text = currentText.join("\n")`, replace it with voice-tag extraction and thread `speaker`:

```typescript
      const joined = currentText.join("\n")
      const { speaker, text } = extractVoiceLabel(joined)
      const range = parseCueRange(currentTimestamp)
      results.push({
        id: uuid(),
        original: text,
        translated: "",
        context: currentTimestamp,
        group: uuid(),
        type: "cue",
        ...(range ? { start: range.start, end: range.end } : {}),
        ...(speaker ? { speaker } : {}),
      })
```

(SRT has no voice-tag syntax; leave `extractSrtStrings` as-is apart from the timecode change from the timecode plan.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/parsers/subtitle.speaker.test.ts`
Expected: PASS. Also rerun `npx vitest run src/lib/parsers/subtitle.test.ts src/lib/parsers/subtitle.timecodes.test.ts` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/parsers/types.ts src/lib/parsers/subtitle.ts src/lib/parsers/subtitle.speaker.test.ts
git commit -m "feat(import): extract VTT <v Name> voice tags into speaker"
```

---

### Task 3: Pure cast-builder — distinct speakers → new voices + assignments

**Files:**
- Create: `src/lib/import/cast-from-speakers.ts`
- Test: `src/lib/import/cast-from-speakers.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { buildCastAdditions } from "./cast-from-speakers"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

describe("buildCastAdditions", () => {
  it("creates one voice per new distinct speaker and assigns cells, reusing existing names", () => {
    const existing: ProjectTtsSettings = { voices: [{ id: "v-mary", name: "Mary", color: "#ec4899" }] }
    const result = buildCastAdditions(
      [
        { cellId: "c1", speaker: "Mary" },   // reuse existing
        { cellId: "c2", speaker: "John" },   // new
        { cellId: "c3", speaker: "John" },   // reuse the just-created John
        { cellId: "c4", speaker: undefined }, // no speaker → no assignment
      ],
      existing,
      () => "new-id",  // deterministic id minter for the test
    )
    // Mary already existed; only John is added.
    expect(result.voices.map((v) => v.name)).toEqual(["Mary", "John"])
    expect(result.castAssignments).toEqual({ c1: "v-mary", c2: "new-id", c3: "new-id" })
  })

  it("returns a no-op (same refs are fine) when there are no speakers", () => {
    const existing: ProjectTtsSettings = { voices: [] }
    const result = buildCastAdditions([{ cellId: "c1", speaker: undefined }], existing, () => "x")
    expect(result.castAssignments).toEqual({})
    expect(result.voices).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/import/cast-from-speakers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

```typescript
// src/lib/import/cast-from-speakers.ts
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { VOICE_PALETTE, getVoiceLibrary } from "@/lib/audio/voices"

export interface SpeakerAssignment {
  cellId: string
  speaker: string | undefined
}

export interface CastAdditions {
  /** Full voice library to persist (existing + newly created). */
  voices: Voice[]
  /** cellId → voiceId for every cue that had a speaker. */
  castAssignments: Record<string, string>
}

/**
 * Given parsed (cellId, speaker) pairs and the current settings, mint one Voice
 * per *new* distinct speaker name (case-sensitive, trimmed) and build the
 * cellId→voiceId assignment map. Names already in the cast are reused. `mintId`
 * is injected for testability (production passes uuidv7).
 */
export function buildCastAdditions(
  pairs: SpeakerAssignment[],
  settings: ProjectTtsSettings | undefined,
  mintId: () => string,
): CastAdditions {
  const voices: Voice[] = [...getVoiceLibrary(settings)]
  const byName = new Map<string, string>() // name → voiceId
  for (const v of voices) byName.set(v.name, v.id)

  const castAssignments: Record<string, string> = {}
  for (const { cellId, speaker } of pairs) {
    const name = speaker?.trim()
    if (!name) continue
    let voiceId = byName.get(name)
    if (!voiceId) {
      voiceId = mintId()
      const color = VOICE_PALETTE[voices.length % VOICE_PALETTE.length]
      voices.push({ id: voiceId, name, color })
      byName.set(name, voiceId)
    }
    castAssignments[cellId] = voiceId
  }
  return { voices, castAssignments }
}
```

(Note: `getVoiceLibrary(settings)` returns the preset Narrator when the project has no custom voices, so imported speakers append after it. If product prefers not to seed the preset, swap to `settings?.voices ? [...settings.voices] : []`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/import/cast-from-speakers.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/import/cast-from-speakers.ts src/lib/import/cast-from-speakers.test.ts
git commit -m "feat(import): build cast additions from subtitle speakers"
```

---

### Task 4: Wire cast creation into the import flow

**Files:**
- Modify: the subtitle-import orchestration so that, after cells are created with stable `cellId`s, `buildCastAdditions` runs and the result is persisted via `saveTts`.

**Context:** `buildBulkCells` (from the timecode plan) already mints a stable `cellId` per cue. To assign speakers we need the `(cellId, speaker)` pairs. Have `buildBulkCells` (or a sibling) also return the speaker pairs, or compute them from the same `strings` + the `cellId`s. The persistence call (`saveTts`) lives in the React layer (`useProjectTts`), so do the cast write where the import dialog has that hook — not deep inside the pure `import.ts`.

- [ ] **Step 1: Expose speaker pairs from cell building**

In `src/lib/import.ts`, add a helper that pairs each created cell with its source string's speaker (it must use the SAME `cellId` minting as `buildBulkCells` — refactor so both share one pass, returning `{ cells, speakerPairs }`):

```typescript
export function buildBulkCellsWithSpeakers(strings: TranslatableString[]): {
  cells: BulkImportCell[]
  speakerPairs: { cellId: string; speaker: string | undefined }[]
} {
  const cells: BulkImportCell[] = []
  const speakerPairs: { cellId: string; speaker: string | undefined }[] = []
  let prevCellId: string | null = null
  for (const str of strings) {
    const cellId = str.id || uuidv7()
    cells.push({
      id: uuidv7(), cellId, anchorCellId: prevCellId, value: str.original,
      ...(str.originalHtml ? { valueHtml: str.originalHtml } : {}),
      ...(str.type !== undefined ? { type: str.type } : {}),
      ...(str.group ? { canonicalRef: str.group } : {}),
      ...(str.start !== undefined ? { startMs: Math.round(str.start * 1000) } : {}),
      ...(str.end !== undefined ? { endMs: Math.round(str.end * 1000) } : {}),
    })
    speakerPairs.push({ cellId, speaker: str.speaker })
    prevCellId = cellId
  }
  return { cells, speakerPairs }
}
```

Have `buildBulkCells` delegate to this (`return buildBulkCellsWithSpeakers(strings).cells`) so the timecode plan's tests stay green.

- [ ] **Step 2: Apply cast additions after a successful subtitle import**

In the import orchestration that has access to `useProjectTts` (e.g. `src/components/ImportDialog.tsx`), after the cells upload succeeds for a VTT/SRT file with any speakers, call:

```typescript
import { buildCastAdditions } from "@/lib/import/cast-from-speakers"
import { v7 as uuidv7 } from "uuid"
// ... inside the import success handler, with `speakerPairs` from buildBulkCellsWithSpeakers:
const hasSpeakers = speakerPairs.some((p) => p.speaker)
if (hasSpeakers) {
  const additions = buildCastAdditions(speakerPairs, project.ttsSettings, uuidv7)
  await saveTts({ voices: additions.voices, castAssignments: { ...(project.ttsSettings?.castAssignments ?? {}), ...additions.castAssignments } })
}
```

(`saveTts` is the single batched write — it persists to localStorage + mirrors to the server settings blob; one call avoids clobbering. `saveTts` comes from `useProjectTts`.)

- [ ] **Step 3: Typecheck + targeted test**

Run: `npx tsc -b` — Expected: no errors.
Add/adjust a unit test for `buildBulkCellsWithSpeakers` (mirror the timecode `buildBulkCells` test, asserting `speakerPairs` line up with cells). Run: `npx vitest run src/lib/import.timecodes.test.ts` (+ your new assertions) — Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/import.ts src/components/ImportDialog.tsx
git commit -m "feat(import): create cast members from subtitle speakers on import"
```

---

### Task 5: VTT exporter with `<v Name>` tags

**Files:**
- Create: `src/lib/export/exporters/vtt.ts`
- Test: `src/lib/export/exporters/vtt.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { exportVtt } from "./vtt"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "src", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }],
  castAssignments: { c1: "v-mary" }, // c2 has no explicit assignment
}

async function text(b: Blob) { return b.text() }

describe("exportVtt", () => {
  it("wraps explicitly-cast cells in <v Name> and leaves others plain", async () => {
    const cells = [
      cell({ id: "c1", translated: "Bonjour", startTime: 1, endTime: 2 }),
      cell({ id: "c2", translated: "Salut", startTime: 2, endTime: 3 }),
    ]
    const out = await text(exportVtt(cells, SETTINGS))
    expect(out).toContain("WEBVTT")
    expect(out).toContain("00:00:01.000 --> 00:00:02.000")
    expect(out).toContain("<v Mary>Bonjour</v>")
    expect(out).toContain("Salut")
    expect(out).not.toContain("<v Mary>Salut")
  })

  it("skips cells with no timecodes", async () => {
    const out = await text(exportVtt([cell({ id: "c1", translated: "x" })], SETTINGS))
    expect(out.trim()).toBe("WEBVTT")
  })

  it("falls back to source text when target is empty", async () => {
    const out = await text(exportVtt([cell({ id: "c1", original: "orig", translated: "", startTime: 0, endTime: 1 })], {}))
    expect(out).toContain("orig")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export/exporters/vtt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/export/exporters/vtt.ts
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
import { escapeVoiceName } from "@/lib/export/vtt-voice"

function fmt(sec: number): string {
  const h = String(Math.floor(sec / 3600)).padStart(2, "0")
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0")
  const s = String(Math.floor(sec % 60)).padStart(2, "0")
  const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, "0")
  return `${h}:${m}:${s}.${ms}`
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
}

/** WEBVTT export. Each timed cell becomes a cue; cells explicitly assigned to a
 *  Cast member get a `<v Name>` voice tag (default-only/unassigned cells stay
 *  plain — matching codex-editor). Cells without timecodes are skipped. */
export function exportVtt(cells: CellData[], settings: ProjectTtsSettings | undefined): Blob {
  const cues: string[] = []
  for (const cell of cells) {
    if (cell.startTime == null || cell.endTime == null) continue
    const raw = (cell.translated || cell.original || "").trim()
    if (!raw) continue
    const text = stripHtml(raw)
    const voiceId = assignedCastVoiceId(settings, cell.id)
    const voice = voiceId ? findVoice(settings, voiceId) : undefined
    const payload = voice ? `<v ${escapeVoiceName(voice.name)}>${text}</v>` : text
    cues.push(`${fmt(cell.startTime)} --> ${fmt(cell.endTime)}\n${payload}`)
  }
  const body = cues.length ? `WEBVTT\n\n${cues.join("\n\n")}\n` : "WEBVTT\n"
  return new Blob([body], { type: "text/vtt;charset=utf-8" })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export/exporters/vtt.test.ts`
Expected: PASS.

- [ ] **Step 5: Register in ExportDialog**

In `src/components/ExportDialog.tsx`: add `"vtt"` to the `ExportFormat` union; add a `FORMAT_OPTIONS` entry (`label: "WebVTT (subtitles)"`, `ext: ".vtt"`, `lossy: true`, description noting cast names become `<v>` tags); add a `case "vtt": blob = exportVtt(cells, project.ttsSettings); break` to the single-file exporter switch (import `exportVtt` from `@/lib/export/exporters/vtt`).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc -b` — Expected: no errors.

```bash
git add src/lib/export/exporters/vtt.ts src/lib/export/exporters/vtt.test.ts src/components/ExportDialog.tsx
git commit -m "feat(export): WebVTT exporter with cast <v Name> voice tags"
```

---

### Task 6: Reconcile the on-screen label to the explicit cast name

**Files:**
- Modify: `src/components/EditorTable.tsx` (around line 1681 where `showCellLabel` is computed)

- [ ] **Step 1: Compute the explicit cast name for the label**

In the row render where `const showCellLabel = cellLabelsEnabled && cell.cellLabel` currently lives, derive the cast name first (ensure `project.ttsSettings` is in scope for this row — it is already passed down for `CellTtsButton`; thread it to this point if needed). Import the helpers:

```typescript
import { assignedCastVoiceId, findVoice } from "@/lib/audio/voices"
```

Replace the label computation with:

```typescript
  const castVoiceId = assignedCastVoiceId(projectTtsSettings, cell.id)
  const castName = castVoiceId ? findVoice(projectTtsSettings, castVoiceId)?.name : undefined
  const labelText = castName ?? cell.cellLabel ?? null
  const showCellLabel = cellLabelsEnabled && labelText
```

and pass `labelText` (instead of `cell.cellLabel`) to the label pill: `label={showCellLabel ? labelText : null}`.

(If `projectTtsSettings` isn't already a prop on this row component, add it — `EditorTable` already holds `project.ttsSettings` and passes it to `CellTtsButton` nearby.)

- [ ] **Step 2: Manual/visual check via the running app**

Use the project's verify flow (`/verify` or `verify-dev-change`): assign a cell to a cast member, enable the cell-labels view toggle, and confirm the cast member's name (not the raw `cellLabel`) shows on the row; a never-cast cell with no `cellLabel` shows nothing.

- [ ] **Step 3: Typecheck + commit**

Run: `npx tsc -b` — Expected: no errors.

```bash
git add src/components/EditorTable.tsx
git commit -m "feat(editor): show assigned cast member name as the cell label"
```

---

### Task 7: E2E round-trip walkthrough

**Files:**
- Create: `e2e/subtitle-voice-roundtrip.spec.ts`

- [ ] **Step 1: Scaffold + author**

Use `/e2e-add`. The spec (as the seeded dev user): import a small `.vtt` fixture containing `<v Mary>` / `<v John>` cues → assert two cast members "Mary" and "John" now exist and the cells show those labels; then export format "WebVTT" → assert the downloaded `.vtt` contains `<v Mary>` and `<v John>` with the original timecodes (round-trip). Include a fixture `.vtt` under `e2e/fixtures/`.

- [ ] **Step 2: Run it**

Run: `npx tsx scripts/e2e-up.ts -- subtitle-voice-roundtrip.spec`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/subtitle-voice-roundtrip.spec.ts e2e/fixtures/
git commit -m "test(e2e): subtitle <v Name> import→cast→export round-trip"
```

---

### Final verification

- [ ] `npm test` — Expected: PASS (vtt-voice, parser speaker, cast-from-speakers, vtt exporter).
- [ ] `npx tsc -b` — Expected: no errors.
- [ ] **DoD check (round-trip):** importing a `.vtt` with `<v Name>` strips the tag, creates one cast member per distinct name (reusing existing names), assigns the cells, preserves timecodes (via the timecode plan), and the editor shows the cast name; exporting WebVTT reproduces `<v Name>` cues with correct timings — a full round-trip. Verified by Tasks 1–5 units + the Task 7 E2E.
- [ ] **DoD check (changing labels — verify existing, not built here):** using the running app (`/verify`), reassign a cell to a different cast member via the `CellVoicePanel` `[Character ▾]` picker, then reload — the assignment persists (localStorage + `/api/v2/projects/:id/settings`); confirm a second browser/session sees the change after settings sync, and that renaming a cast member updates every cell that resolves to it. This exercises the pre-existing `useProjectTts.assignCells` + settings-sync path the new label display depends on.

### Notes
- SRT export of speakers is out of scope (no native `<v>` syntax).
- Default-only cells intentionally export plain text (no `<v>`), matching codex-editor's "no tag unless labeled."
