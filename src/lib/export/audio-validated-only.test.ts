// AQU-965: "validated takes only" across all four audio deliverables.
//
// The scope marks; each exporter decides what a marked take becomes. These
// tests pin that per-deliverable promise, because it is the part a future
// exporter is most likely to get wrong by treating "withdrawn" as "filter it
// out" everywhere:
//
//   by line     → no file for that line
//   by character→ silence in place (timeline placement does it)
//   chapter     → a GAP of the take's own length, written explicitly
//   assembly    → silence in place, and the manifest says why
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import { quantisePcm16 } from "@/lib/audio/wav-encode"
import { scopeAudioCellsForExport } from "./audio-validation-scope"
import { exportAudioPerLine } from "./audio-per-line"
import { exportAudioByCharacter, groupAudioByCharacter } from "./audio-by-character"
import { exportAudioByChapter, silencedGapSamples } from "./audio-chapter"
import { assembleAudioEntries } from "./audio-assembly"

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }],
  defaultVoiceId: "v-mary",
  castAssignments: { v1: "v-mary", v2: "v-mary" },
}

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f1", original: "", translated: "", context: "", group: "",
    type: "verse", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

/** A recorded line: one take on the default track, `votes` validators. */
const line = (
  id: string,
  votes: number,
  over: Partial<CellData> = {},
  att: Partial<CodexCellAttachment> = {},
): CellData =>
  cell({
    id,
    selectedAudioId: `a-${id}`,
    attachments: {
      [`a-${id}`]: {
        url: `frontier-audio://a-${id}.wav`,
        type: "audio/wav",
        slot: "recording",
        validatorCount: votes,
        ...att,
      },
    },
    ...over,
  })

/** Byte payload = the audioId, so a fake decode can key its PCM off it. */
const fetchBytes = async ({ audioId }: { audioId: string }) =>
  new TextEncoder().encode(audioId)

const decodeFrom = (pcmById: Record<string, Float32Array>) =>
  async (bytes: Uint8Array): Promise<Float32Array> =>
    pcmById[new TextDecoder().decode(bytes)] ?? new Float32Array([0])

async function wavSamples(blob: Blob): Promise<number[]> {
  const buf = await blob.arrayBuffer()
  const dv = new DataView(buf)
  const out: number[] = []
  for (let i = 44; i < buf.byteLength; i += 2) out.push(dv.getInt16(i, true))
  return out
}

/** The validated-only cells, at a threshold of one vote. */
const validatedOnly = (cells: CellData[]): CellData[] =>
  scopeAudioCellsForExport(cells, "validated-only", 1)

describe("by line — a withdrawn take writes no file", () => {
  const cells = [
    line("v1", 1, { startTime: 0, endTime: 1 }),
    line("v2", 0, { startTime: 1, endTime: 2 }),
  ]

  it("omits the unvalidated line and keeps the validated one, numbering untouched", async () => {
    const result = await exportAudioPerLine({
      cells: validatedOnly(cells),
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fileBase: "ep1",
      fetchBytes,
    })
    const names = Object.keys(await JSZip.loadAsync(result.blob).then((z) => z.files))
    // L0001 is still L0001: lines are numbered per file, recorded or not, so
    // the files that remain keep the names they would have had.
    expect(names.filter((n) => n.endsWith(".wav"))).toEqual(["ep1_swh_L0001_Mary.wav"])
  })

  it("exports both lines in the default mode, validated or not", async () => {
    const result = await exportAudioPerLine({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fileBase: "ep1",
      fetchBytes,
    })
    const names = Object.keys(await JSZip.loadAsync(result.blob).then((z) => z.files))
    expect(names.filter((n) => n.endsWith(".wav")).length).toBe(2)
  })
})

describe("by character — a withdrawn take leaves silence in place", () => {
  const cells = [
    line("v1", 1, { startTime: 0, endTime: 1 }),
    line("v2", 0, { startTime: 2, endTime: 3 }),
  ]

  it("drops the clip from the character's track, so the track falls quiet there", () => {
    const groups = groupAudioByCharacter(validatedOnly(cells), SETTINGS)
    expect(groups[0].clips.map((c) => c.audioId)).toEqual(["a-v1"])
  })

  it("keeps every surviving take at its own timeline second", async () => {
    const result = await exportAudioByCharacter({
      cells: validatedOnly([
        line("v1", 0, { startTime: 0, endTime: 1 }),
        line("v2", 1, { startTime: 1, endTime: 2 }),
      ]),
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fileBase: "ep1",
      fetchBytes,
      decode: decodeFrom({ "a-v2": new Float32Array([0.5]) }),
    })
    const zip = await JSZip.loadAsync(result.blob)
    const entry = Object.keys(zip.files).find((n) => n.endsWith(".wav"))!
    const samples = await wavSamples(await zip.files[entry].async("blob"))
    // The withdrawn v1 occupied second 0; v2 still starts at second 1 rather
    // than sliding forward into the gap.
    expect(samples.length).toBeGreaterThan(TARGET_RATE)
    expect(samples[TARGET_RATE]).toBe(quantisePcm16(0.5))
    expect(samples.slice(0, TARGET_RATE).every((s) => s === 0)).toBe(true)
  })
})

describe("chapter — a withdrawn take becomes a gap of its own length", () => {
  it("writes silence the length of the take instead of closing the gap up", async () => {
    const cells = [
      line("v1", 1, { group: "MAT 1:1" }),
      line("v2", 0, { group: "MAT 1:2" }, { durationMs: 1000 }),
      line("v3", 1, { group: "MAT 1:3" }),
    ]
    const result = await exportAudioByChapter({
      cells: validatedOnly(cells),
      projectId: "p1",
      fetchBytes,
      decode: decodeFrom({
        "a-v1": new Float32Array([0.5]),
        "a-v3": new Float32Array([0.25]),
      }),
    })
    expect(result.silenced).toBe(1)
    const samples = await wavSamples(result.blob)
    expect(samples.length).toBe(2 + TARGET_RATE)
    expect(samples[0]).toBe(quantisePcm16(0.5))
    expect(samples.slice(1, 1 + TARGET_RATE).every((s) => s === 0)).toBe(true)
    expect(samples[1 + TARGET_RATE]).toBe(quantisePcm16(0.25))
  })

  it("sizes the gap off the decoded samples when the duration is unknown", async () => {
    const result = await exportAudioByChapter({
      cells: validatedOnly([
        line("v1", 0, { group: "MAT 1:1" }),
        line("v2", 1, { group: "MAT 1:2" }),
      ]),
      projectId: "p1",
      fetchBytes,
      decode: decodeFrom({
        "a-v1": new Float32Array([0.5, 0.5, 0.5]),
        "a-v2": new Float32Array([0.25]),
      }),
    })
    expect(result.silenced).toBe(1)
    expect(await wavSamples(result.blob)).toEqual([0, 0, 0, quantisePcm16(0.25)])
  })

  it("stitches an unvalidated take as before in the default mode", async () => {
    const cells = [line("v1", 0, { group: "MAT 1:1" })]
    const result = await exportAudioByChapter({
      cells,
      projectId: "p1",
      fetchBytes,
      decode: decodeFrom({ "a-v1": new Float32Array([0.5]) }),
    })
    expect(result.silenced).toBe(0)
    expect(await wavSamples(result.blob)).toEqual([quantisePcm16(0.5)])
  })
})

describe("silencedGapSamples", () => {
  it("measures the audible slice, not the whole stored clip", () => {
    expect(silencedGapSamples({ durationMs: 2000, trimStartMs: 500, trimEndMs: 1000 }, 1000))
      .toBe(500)
  })

  it("falls back to the full clip for an incoherent window, as the trim read does", () => {
    expect(silencedGapSamples({ durationMs: 2000, trimStartMs: 1500, trimEndMs: 500 }, 1000))
      .toBe(2000)
  })

  it("has no answer without a duration, so the caller decodes to measure", () => {
    expect(silencedGapSamples({ durationMs: null }, 1000)).toBeNull()
    expect(silencedGapSamples({}, 1000)).toBeNull()
  })
})

describe("assembly — a withdrawn take is silence in place, and the manifest says why", () => {
  it("records the omission rather than losing it", async () => {
    const result = await assembleAudioEntries({
      cells: validatedOnly([line("v1", 1), line("v2", 0)]),
      settings: SETTINGS,
      projectId: "p1",
      fileSlug: "genesis",
      langCode: "swh",
      mode: "separate-clips",
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => new Float32Array([0]),
    })
    expect(result.entries.map((e) => e.name)).toEqual(["000_v1_Mary.wav"])
    expect(result.skipped).toEqual([{ cellId: "v2", reason: "no validated take" }])
  })
})
