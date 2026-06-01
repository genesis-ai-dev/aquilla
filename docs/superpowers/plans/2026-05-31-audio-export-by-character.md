# Audio Export by Character Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side export that produces a ZIP with one WAV per cast member — each WAV is that character's audio clips concatenated in document order, using the best-available audio per cell (recording → generated).

**Architecture:** Pure functions do the work that can be unit-tested in happy-dom (grouping cells by resolved cast voice, preview stats, PCM concatenation, WAV encoding). A thin Web-Audio adapter (`decodeToMono48k`) converts fetched bytes → mono 48 kHz `Float32Array`; it's injected into the orchestrator so tests can supply a fake decoder. Delivery reuses `fetchCellAudio`, `JSZip`, and `downloadBlob`. Surfaced as a new `"audio-by-character"` option in `ExportDialog`.

**Tech Stack:** TypeScript, Web Audio API (`AudioContext.decodeAudioData`), JSZip, vitest (happy-dom). No native FFmpeg.

**Independent:** no dependency on the timecode plan (concatenation uses document order, not timecodes).

---

### Spec reference
`docs/superpowers/specs/2026-05-31-character-names-audio-export-design.md` §5 "Slice B".
**Decision recorded:** surfaced inside `ExportDialog` as a new format (simpler than a standalone workspace action; reuses the existing export entry point). Server-side FFmpeg *timeline-synced stems* remain deferred.

### Reusable pieces (already exist — do not re-implement)
- `resolveCastVoice(settings, cellId, cellVoiceId)` → `Voice` (id, name, color) — `src/lib/audio/voices.ts`
- `fetchCellAudio({ projectId, fileId, audioId, ext, getSyncToken })` → `Uint8Array` — `src/lib/audio/upload.ts`
- `parseFrontierAudioUrl(url)` → `{ audioId, ext }` — `src/lib/audio/upload.ts`
- `audioSyncTokenFetcherForSession(session)` → `SyncTokenForFile` — `src/lib/audio/sync-token-fetcher.ts`
- `downloadBlob(blob, filename)` — `src/lib/export/export-service.ts`
- `CellData` (`selectedAudioId`, `selectedGeneratedVoiceAudioId`, `attachments`, `ttsSettings`) — `src/hooks/useCells.ts`

### File map
- Create: `src/lib/audio/wav-encode.ts` + test
- Create: `src/lib/export/audio-by-character.ts` (grouping, preview, concat, orchestrator) + tests
- Create: `src/lib/audio/decode-mono.ts` (Web-Audio adapter; not unit-tested)
- Modify: `src/components/ExportDialog.tsx` (new format option + dispatch + inline preview)
- Create: `e2e/audio-by-character.spec.ts` (real-UI walkthrough)

---

### Task 1: WAV encoder (pure)

**Files:**
- Create: `src/lib/audio/wav-encode.ts`
- Test: `src/lib/audio/wav-encode.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { encodeWavPcm16 } from "./wav-encode"

async function bytes(blob: Blob): Promise<DataView> {
  return new DataView(await blob.arrayBuffer())
}

describe("encodeWavPcm16", () => {
  it("writes a valid mono 16-bit RIFF/WAVE header", async () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1])
    const dv = await bytes(encodeWavPcm16(samples, 48000))
    // "RIFF"
    expect(String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))).toBe("RIFF")
    // "WAVE"
    expect(String.fromCharCode(dv.getUint8(8), dv.getUint8(9), dv.getUint8(10), dv.getUint8(11))).toBe("WAVE")
    expect(dv.getUint16(22, true)).toBe(1)       // channels = mono
    expect(dv.getUint32(24, true)).toBe(48000)   // sample rate
    expect(dv.getUint16(34, true)).toBe(16)      // bits per sample
    // data chunk size = samples * 2 bytes
    expect(dv.getUint32(40, true)).toBe(5 * 2)
  })

  it("clamps and quantizes samples to int16 range", async () => {
    const dv = await bytes(encodeWavPcm16(new Float32Array([1, -1, 2, -2]), 8000))
    const first = dv.getInt16(44, true)
    const second = dv.getInt16(46, true)
    expect(first).toBe(32767)   // +1.0 → max
    expect(second).toBe(-32768) // -1.0 → min
    expect(dv.getInt16(48, true)).toBe(32767)  // +2.0 clamped
    expect(dv.getInt16(50, true)).toBe(-32768) // -2.0 clamped
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/audio/wav-encode.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// src/lib/audio/wav-encode.ts
// Encode mono PCM Float32 samples to a 16-bit WAV blob. No Web Audio needed —
// pure DataView writes — so it is unit-testable in happy-dom.

export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2
  const buffer = new ArrayBuffer(44 + dataBytes)
  const dv = new DataView(buffer)

  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(offset + i, s.charCodeAt(i))
  }

  writeStr(0, "RIFF")
  dv.setUint32(4, 36 + dataBytes, true)
  writeStr(8, "WAVE")
  writeStr(12, "fmt ")
  dv.setUint32(16, 16, true)          // PCM fmt chunk size
  dv.setUint16(20, 1, true)           // audio format = PCM
  dv.setUint16(22, 1, true)           // channels = mono
  dv.setUint32(24, sampleRate, true)
  dv.setUint32(28, sampleRate * 2, true) // byte rate (mono * 2 bytes)
  dv.setUint16(32, 2, true)           // block align
  dv.setUint16(34, 16, true)          // bits per sample
  writeStr(36, "data")
  dv.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    dv.setInt16(offset, Math.round(clamped * (clamped < 0 ? 0x8000 : 0x7fff)), true)
    offset += 2
  }
  return new Blob([buffer], { type: "audio/wav" })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/audio/wav-encode.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/audio/wav-encode.ts src/lib/audio/wav-encode.test.ts
git commit -m "feat(audio): add mono PCM16 WAV encoder"
```

---

### Task 2: Group cells by character + preview (pure)

**Files:**
- Create: `src/lib/export/audio-by-character.ts`
- Test: `src/lib/export/audio-by-character.group.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { groupAudioByCharacter, previewAudioByCharacter } from "./audio-by-character"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [
    { id: "v-mary", name: "Mary", color: "#ec4899" },
    { id: "v-john", name: "John", color: "#0ea5e9" },
  ],
  defaultVoiceId: "v-mary",
  castAssignments: { c1: "v-mary", c2: "v-john", c3: "v-mary" },
}

describe("groupAudioByCharacter", () => {
  it("buckets cells by resolved cast voice, preserving input (document) order, picking best-available audio", () => {
    const cells = [
      cell({ id: "c1", selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm" } } }),
      cell({ id: "c2", selectedGeneratedVoiceAudioId: "g2", attachments: { g2: { url: "frontier-audio://g2.wav", type: "audio/wav" } } }),
      cell({ id: "c3", selectedAudioId: "a3", attachments: { a3: { url: "frontier-audio://a3.webm", type: "audio/webm" } } }),
      cell({ id: "c4" }), // no audio → skipped
    ]
    const groups = groupAudioByCharacter(cells, SETTINGS)
    const mary = groups.find((g) => g.voice.id === "v-mary")!
    const john = groups.find((g) => g.voice.id === "v-john")!
    expect(mary.clips.map((x) => x.audioId)).toEqual(["a1", "a3"]) // doc order, recording slot
    expect(john.clips.map((x) => x.audioId)).toEqual(["g2"])       // generated fallback
    expect(groups.flatMap((g) => g.clips).some((c) => c.cellId === "c4")).toBe(false)
  })
})

describe("previewAudioByCharacter", () => {
  it("reports per-character clip counts and (when known) total duration ms", () => {
    const cells = [
      cell({ id: "c1", selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm", durationMs: 1000 } } }),
      cell({ id: "c3", selectedAudioId: "a3", attachments: { a3: { url: "frontier-audio://a3.webm", type: "audio/webm", durationMs: 1500 } } }),
    ]
    const preview = previewAudioByCharacter(cells, SETTINGS)
    const mary = preview.find((p) => p.voiceId === "v-mary")!
    expect(mary.clipCount).toBe(2)
    expect(mary.totalDurationMs).toBe(2500)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export/audio-by-character.group.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement grouping + preview**

```typescript
// src/lib/export/audio-by-character.ts
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { resolveCastVoice } from "@/lib/audio/voices"

export interface CharacterClip {
  cellId: string
  audioId: string
  /** frontier-audio:// URL on the chosen attachment. */
  url: string
}

export interface CharacterGroup {
  voice: Voice
  clips: CharacterClip[]
}

export interface CharacterPreview {
  voiceId: string
  name: string
  color?: string
  clipCount: number
  /** Sum of known attachment durations; null when any clip lacks durationMs. */
  totalDurationMs: number | null
}

/** Pick the best-available audio for a cell: recording slot first, else
 *  generated-voice slot. Returns null when the cell has no usable audio. */
function bestAudioId(cell: CellData): string | null {
  return cell.selectedAudioId ?? cell.selectedGeneratedVoiceAudioId ?? null
}

export function groupAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
): CharacterGroup[] {
  const order: string[] = []
  const byVoice = new Map<string, CharacterGroup>()

  for (const cell of cells) {
    const audioId = bestAudioId(cell)
    if (!audioId) continue
    const attachment = cell.attachments?.[audioId]
    if (!attachment?.url) continue
    const voice = resolveCastVoice(settings, cell.id, cell.ttsSettings?.voiceId)
    let group = byVoice.get(voice.id)
    if (!group) {
      group = { voice, clips: [] }
      byVoice.set(voice.id, group)
      order.push(voice.id)
    }
    group.clips.push({ cellId: cell.id, audioId, url: attachment.url })
  }
  return order.map((id) => byVoice.get(id)!)
}

export function previewAudioByCharacter(
  cells: CellData[],
  settings: ProjectTtsSettings | undefined,
): CharacterPreview[] {
  return groupAudioByCharacter(cells, settings).map((g) => {
    let total: number | null = 0
    for (const clip of g.clips) {
      const dur = findCell(cells, clip.cellId)?.attachments?.[clip.audioId]?.durationMs
      if (dur == null || total == null) total = null
      else total += dur
    }
    return {
      voiceId: g.voice.id,
      name: g.voice.name,
      color: g.voice.color,
      clipCount: g.clips.length,
      totalDurationMs: total,
    }
  })
}

function findCell(cells: CellData[], id: string): CellData | undefined {
  return cells.find((c) => c.id === id)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export/audio-by-character.group.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/export/audio-by-character.ts src/lib/export/audio-by-character.group.test.ts
git commit -m "feat(export): group cells by cast character + preview stats"
```

---

### Task 3: PCM concatenation (pure)

**Files:**
- Modify: `src/lib/export/audio-by-character.ts` (add `concatPcm`)
- Test: `src/lib/export/audio-by-character.concat.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest"
import { concatPcm } from "./audio-by-character"

describe("concatPcm", () => {
  it("joins clips back-to-back in order", () => {
    const out = concatPcm([new Float32Array([1, 2]), new Float32Array([3]), new Float32Array([4, 5])])
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it("returns an empty array for no clips", () => {
    expect(concatPcm([]).length).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export/audio-by-character.concat.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `src/lib/export/audio-by-character.ts`:

```typescript
/** Concatenate mono PCM clips (all assumed at the same sample rate) into one
 *  Float32Array. Document-order back-to-back; no silence, no timeline. */
export function concatPcm(clips: Float32Array[]): Float32Array {
  let total = 0
  for (const c of clips) total += c.length
  const out = new Float32Array(total)
  let offset = 0
  for (const c of clips) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export/audio-by-character.concat.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/export/audio-by-character.ts src/lib/export/audio-by-character.concat.test.ts
git commit -m "feat(export): add mono PCM concatenation helper"
```

---

### Task 4: Web-Audio decode adapter (thin, not unit-tested)

**Files:**
- Create: `src/lib/audio/decode-mono.ts`

- [ ] **Step 1: Implement the adapter**

```typescript
// src/lib/audio/decode-mono.ts
// Decode compressed audio bytes (webm/opus/wav/mp3) to a mono Float32Array at a
// target sample rate via Web Audio. Decoding through a context created at
// TARGET_RATE makes decodeAudioData resample for us, so all clips come out at a
// common rate and concatenate cleanly. Browser-only — verified via E2E, not units.

export const TARGET_RATE = 48000

type AudioCtor = typeof AudioContext

function getAudioContextCtor(): AudioCtor {
  const w = globalThis as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor }
  const Ctor = w.AudioContext ?? w.webkitAudioContext
  if (!Ctor) throw new Error("Web Audio API is unavailable in this environment")
  return Ctor
}

export async function decodeToMono48k(bytes: Uint8Array): Promise<Float32Array> {
  const Ctor = getAudioContextCtor()
  const ctx = new Ctor({ sampleRate: TARGET_RATE })
  try {
    // decodeAudioData wants an ArrayBuffer; copy to detach from the Uint8Array view.
    const ab = bytes.slice().buffer
    const decoded = await ctx.decodeAudioData(ab)
    if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice()
    // Downmix to mono by averaging channels.
    const len = decoded.length
    const mono = new Float32Array(len)
    for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
      const data = decoded.getChannelData(ch)
      for (let i = 0; i < len; i++) mono[i] += data[i] / decoded.numberOfChannels
    }
    return mono
  } finally {
    void ctx.close()
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc -b`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/audio/decode-mono.ts
git commit -m "feat(audio): add Web-Audio decode-to-mono-48k adapter"
```

---

### Task 5: Orchestrator — fetch → decode → concat → WAV → zip (injectable decoder)

**Files:**
- Modify: `src/lib/export/audio-by-character.ts` (add `exportAudioByCharacter`)
- Test: `src/lib/export/audio-by-character.export.test.ts`

- [ ] **Step 1: Write the failing test (fake fetch + fake decode)**

```typescript
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportAudioByCharacter } from "./audio-by-character"
import type { CellData } from "@/hooks/useCells"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary", color: "#ec4899" }, { id: "v-john", name: "John" }],
  castAssignments: { c1: "v-mary", c2: "v-john" },
}

describe("exportAudioByCharacter", () => {
  it("produces a zip with one WAV per character, sanitized filenames", async () => {
    const cells = [
      cell({ id: "c1", selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } } }),
      cell({ id: "c2", selectedAudioId: "a2", attachments: { a2: { url: "frontier-audio://a2.wav", type: "audio/wav" } } }),
    ]
    const blob = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1, 0.2, 0.3]),
    })
    const zip = await JSZip.loadAsync(blob)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(["Mary_swh.wav", "John_swh.wav"].sort())
  })

  it("skips characters with no audio and reports zero entries cleanly", async () => {
    const blob = await exportAudioByCharacter({
      cells: [cell({ id: "c1" })],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array(),
      decode: async () => new Float32Array(),
    })
    const zip = await JSZip.loadAsync(blob)
    expect(Object.keys(zip.files)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/export/audio-by-character.export.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the orchestrator**

Add to `src/lib/export/audio-by-character.ts`:

```typescript
import JSZip from "jszip"
import { encodeWavPcm16 } from "@/lib/audio/wav-encode"
import { parseFrontierAudioUrl } from "@/lib/audio/upload"
import { TARGET_RATE } from "@/lib/audio/decode-mono"

/** Filesystem-safe character key (mirrors codex-editor's sanitization). */
export function characterKey(name: string): string {
  return name.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "unnamed"
}

export interface ExportAudioArgs {
  cells: CellData[]
  settings: ProjectTtsSettings | undefined
  projectId: string
  langCode: string
  /** Fetch raw bytes for one clip. Production passes a closure over
   *  fetchCellAudio + the file's sync token. */
  fetchBytes: (args: { projectId: string; fileId: string; audioId: string; ext: string }) => Promise<Uint8Array>
  /** Decode bytes → mono PCM at TARGET_RATE. Production passes decodeToMono48k;
   *  tests pass a fake. */
  decode: (bytes: Uint8Array) => Promise<Float32Array>
  onProgress?: (done: number, total: number) => void
}

export async function exportAudioByCharacter(args: ExportAudioArgs): Promise<Blob> {
  const groups = groupAudioByCharacter(args.cells, args.settings)
  const zip = new JSZip()
  const usedNames = new Map<string, number>()
  const totalClips = groups.reduce((n, g) => n + g.clips.length, 0)
  let done = 0

  for (const group of groups) {
    const pcmClips: Float32Array[] = []
    for (const clip of group.clips) {
      const cell = args.cells.find((c) => c.id === clip.cellId)!
      const parsed = parseFrontierAudioUrl(clip.url)
      if (!parsed) { done++; args.onProgress?.(done, totalClips); continue }
      const bytes = await args.fetchBytes({
        projectId: args.projectId, fileId: cell.fileId, audioId: parsed.audioId, ext: parsed.ext,
      })
      if (bytes.length > 0) pcmClips.push(await args.decode(bytes))
      done++
      args.onProgress?.(done, totalClips)
    }
    const pcm = concatPcm(pcmClips)
    if (pcm.length === 0) continue // character ended up with no decodable audio
    const wav = encodeWavPcm16(pcm, TARGET_RATE)
    // Disambiguate same-named cast members.
    const base = `${characterKey(group.voice.name)}_${args.langCode}`
    const seen = usedNames.get(base) ?? 0
    usedNames.set(base, seen + 1)
    const name = seen === 0 ? `${base}.wav` : `${base}_${seen + 1}.wav`
    zip.file(name, wav)
  }

  return zip.generateAsync({ type: "blob", compression: "DEFLATE" })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/export/audio-by-character.export.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/export/audio-by-character.ts src/lib/export/audio-by-character.export.test.ts
git commit -m "feat(export): orchestrate audio-by-character zip (injectable decode)"
```

---

### Task 6: Wire into ExportDialog (new format + inline preview)

**Files:**
- Modify: `src/components/ExportDialog.tsx`

- [ ] **Step 1: Add the format to the union + options**

In `src/components/ExportDialog.tsx`:
- Extend `ExportFormat`: `... | "tmx" | "audio-by-character"`.
- Add to `FORMAT_OPTIONS`:

```typescript
  {
    id: "audio-by-character",
    label: "Audio by character",
    ext: ".zip",
    description: "One WAV per cast member — each character's clips concatenated, best-available audio (recording → generated). Concatenated order = document order.",
    lossy: false,
  },
```

- [ ] **Step 2: Render the inline preview when selected**

When `format === "audio-by-character"` and `scope === "file"`, compute `previewAudioByCharacter(cells, project.ttsSettings)` and render a small summary list (one row per character: color dot, name, `clipCount` clips, and `totalDurationMs` formatted `m:ss` when non-null). Import `previewAudioByCharacter` from `@/lib/export/audio-by-character`. This is read-only and cheap (no fetch/decode).

- [ ] **Step 3: Add the export dispatch branch**

In `handleExport()`, add a branch before the generic client-side exporter switch:

```typescript
    } else if (format === "audio-by-character") {
      setStatus({ kind: "busy", msg: "Decoding audio…" })
      const { exportAudioByCharacter } = await import("@/lib/export/audio-by-character")
      const { decodeToMono48k } = await import("@/lib/audio/decode-mono")
      const { fetchCellAudio } = await import("@/lib/audio/upload")
      const blob = await exportAudioByCharacter({
        cells,
        settings: project.ttsSettings,
        projectId,
        langCode: targetLanguage || "und",
        fetchBytes: ({ projectId, fileId, audioId, ext }) =>
          fetchCellAudio({ projectId, fileId, audioId, ext, getSyncToken: getSyncToken }),
        decode: decodeToMono48k,
        onProgress: (d, t) => setStatus({ kind: "busy", msg: `Decoding ${d}/${t}…` }),
      })
      const safe = (activeFileName ?? "audio").replace(/\.[^.]+$/, "")
      downloadBlob(blob, `${safe}_audio-by-character.zip`)
      setStatus({ kind: "ok", msg: "Exported audio by character" })
```

(`getSyncToken` is the file-scoped token getter already available in this component for audio reads; if the dialog only has a project-level token getter, derive a `SyncTokenForFile` via `audioSyncTokenFetcherForSession(session)` from `@/lib/audio/sync-token-fetcher`.)

- [ ] **Step 4: Typecheck + lint**

Run: `npx tsc -b` — Expected: no errors.
Run: `npx eslint src/components/ExportDialog.tsx src/lib/export/audio-by-character.ts` — Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/components/ExportDialog.tsx
git commit -m "feat(export): add Audio-by-character option to the export dialog"
```

---

### Task 7: E2E real-UI walkthrough

**Files:**
- Create: `e2e/audio-by-character.spec.ts`

- [ ] **Step 1: Scaffold from template**

Use the project's E2E scaffolder (`/e2e-add`) or copy an existing spec under `e2e/`. The spec should, as the seeded dev user: open a project that has cast assignments + per-cell audio, open the export dialog, choose "Audio by character", assert the preview lists the expected characters, trigger the export, and assert a `.zip` download occurs (Playwright `page.waitForEvent("download")`).

- [ ] **Step 2: Run it**

Run: `npm run test:e2e:smoke` (or `npx tsx scripts/e2e-up.ts -- audio-by-character.spec`)
Expected: PASS — download captured, filename ends `_audio-by-character.zip`.

- [ ] **Step 3: Commit**

```bash
git add e2e/audio-by-character.spec.ts
git commit -m "test(e2e): audio-by-character export walkthrough"
```

---

### Final verification

- [ ] `npm test` — Expected: PASS (wav-encode, grouping, preview, concat, orchestrator).
- [ ] `npx tsc -b` — Expected: no errors.
- [ ] **DoD check:** exporting "Audio by character" on a 2-character fixture yields a zip with 2 WAVs named per character; characters without audio are skipped; preview shows per-character clip counts/durations. Trim-honoring is intentionally deferred (the client `CodexCellAttachment` type does not yet surface `trimStartMs/trimEndMs`); clips export full-length. Note this limitation in the dialog description if product wants it visible.

### Deferred (documented, not built here)
- Honoring non-destructive trim (`trim_start_ms`/`trim_end_ms`) — needs the client attachment type to surface trim.
- FLAC/Opus output (needs an encoder lib).
- Server-side FFmpeg **timeline-synced stems** (the bigger "later" — uses the persisted `start_ms`/`end_ms` from the timecode plan).
