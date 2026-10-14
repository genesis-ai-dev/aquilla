import { describe, it, expect } from "vitest"
import {
  applyTrimPcm,
  assembleAudioEntries,
  buildTimeline,
  SILENCE_CHUNK_SAMPLES,
  writeTimelineTrackParts,
  type AudioAssemblyArgs,
  type TimelineClip,
} from "./audio-assembly"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import type { CellData } from "@/hooks/useCells"
import type { CodexCellAttachment } from "@/lib/codex-editor/types"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "cue", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

/** Cell whose selected recording is `<audioId>.<ext>` with optional trim window. */
function audioCell(
  id: string,
  audioId: string,
  ext: string,
  over: Partial<CodexCellAttachment> = {},
  slot: "selectedAudioId" | "selectedGeneratedVoiceAudioId" = "selectedAudioId",
): CellData {
  return cell({
    id,
    [slot]: audioId,
    attachments: { [audioId]: { url: `frontier-audio://${audioId}.${ext}`, type: `audio/${ext}`, ...over } },
  })
}

const SETTINGS: ProjectTtsSettings = {
  voices: [{ id: "v-mary", name: "Mary" }, { id: "v-john", name: "John" }],
  castAssignments: { c1: "v-mary", c2: "v-john", c3: "v-mary" },
}

/** Deterministic fake decode: PCM length = byte count, value = first byte / 100. */
const fakeDecode = async (bytes: Uint8Array): Promise<Float32Array> =>
  new Float32Array(bytes.length).fill((bytes[0] ?? 0) / 100)

function clipBytes(marker: number, samples: number): Uint8Array {
  const b = new Uint8Array(samples)
  b.fill(marker)
  return b
}

/** Registry-backed fetch fake keyed `<audioId>.<ext>`; records every call. */
function makeFetch(clips: Record<string, Uint8Array>) {
  const calls: string[] = []
  const fetchBytes: AudioAssemblyArgs["fetchBytes"] = async ({ audioId, ext }) => {
    const key = `${audioId}.${ext}`
    calls.push(key)
    const bytes = clips[key]
    if (!bytes) throw Object.assign(new Error(`audio not found (404): ${key}`), { status: 404 })
    return bytes
  }
  return { calls, fetchBytes }
}

function baseArgs(over: Partial<AudioAssemblyArgs>): AudioAssemblyArgs {
  return {
    cells: [],
    settings: SETTINGS,
    projectId: "p1",
    fileSlug: "genesis",
    langCode: "swh",
    mode: "separate-clips",
    fetchBytes: async () => new Uint8Array([1]),
    decode: fakeDecode,
    ...over,
  }
}

async function wavSamples(blob: Blob): Promise<Int16Array> {
  const dv = new DataView(await blob.arrayBuffer())
  const n = dv.getUint32(40, true) / 2 // data-chunk bytes → 16-bit sample count
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(44 + i * 2, true)
  return out
}

const wavSampleCount = (blob: Blob): number => (blob.size - 44) / 2

describe("applyTrimPcm", () => {
  it("slices the ms trim window into sample offsets at the given rate", () => {
    const pcm = new Float32Array(480) // 10ms at 48k
    for (let i = 0; i < pcm.length; i++) pcm[i] = i
    const out = applyTrimPcm(pcm, TARGET_RATE, 2, 7)
    expect(out.length).toBe(240) // [96, 336)
    expect(out[0]).toBe(96)
    expect(out[239]).toBe(335)
  })

  it("clamps out-of-range windows and empties inverted ones", () => {
    const pcm = new Float32Array(100)
    expect(applyTrimPcm(pcm, TARGET_RATE, null, 9999).length).toBe(100)
    expect(applyTrimPcm(pcm, TARGET_RATE, 9999, null).length).toBe(0)
    expect(applyTrimPcm(pcm, TARGET_RATE, 7, 2).length).toBe(0)
  })

  it("returns the untouched input when there is nothing to trim (no per-cell copies of shared clips)", () => {
    const pcm = new Float32Array(100)
    expect(applyTrimPcm(pcm, TARGET_RATE, 0, null)).toBe(pcm)
    expect(applyTrimPcm(pcm, TARGET_RATE)).toBe(pcm)
  })
})

describe("assembleAudioEntries — separate-clips", () => {
  it("passes untrimmed unique clips through as raw stored bytes, never decoding", async () => {
    const stored = clipBytes(10, 6)
    const { fetchBytes } = makeFetch({ "a1.mp3": stored })
    let decodes = 0
    const result = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "a1", "mp3")],
      fetchBytes,
      decode: async (b) => { decodes++; return fakeDecode(b) },
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.mp3"])
    expect(result.entries[0].data.type).toBe("audio/mpeg")
    expect(new Uint8Array(await result.entries[0].data.arrayBuffer())).toEqual(stored)
    expect(decodes).toBe(0) // raw passthrough must not transcode
  })

  it("decodes + slices trimmed clips to per-cell WAVs", async () => {
    const { fetchBytes } = makeFetch({ "a1.webm": clipBytes(10, 480) })
    const result = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "a1", "webm", { trimStartMs: 2, trimEndMs: 7 })],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.wav"])
    expect(wavSampleCount(result.entries[0].data)).toBe(240) // 5ms of the 10ms clip
  })

  it("fetches a clip shared by multiple cells ONCE, emitting one WAV per cell", async () => {
    // Combined-voice generations attach one untrimmed clip to many cells — the
    // decode path (not raw copy) keeps the zip from repeating the full clip.
    const { calls, fetchBytes } = makeFetch({ "combo.webm": clipBytes(10, 100) })
    const result = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "combo", "webm"), audioCell("c2", "combo", "webm")],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.wav", "001_c2_John.wav"])
    expect(calls).toEqual(["combo.webm"]) // deduped fetch+decode
  })

  it("prefers the lossless WAV sibling for generated webm clips, falling back when missing", async () => {
    const wavBytes = clipBytes(20, 8)
    const havingSibling = makeFetch({ "gen-1.wav": wavBytes, "gen-1.webm": clipBytes(10, 4) })
    const withSibling = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "gen-1", "webm", {}, "selectedGeneratedVoiceAudioId")],
      fetchBytes: havingSibling.fetchBytes,
    }))
    expect(havingSibling.calls).toEqual(["gen-1.wav"])
    expect(withSibling.entries.map((e) => e.name)).toEqual(["000_c1_Mary.wav"])
    expect(new Uint8Array(await withSibling.entries[0].data.arrayBuffer())).toEqual(wavBytes)

    const missingSibling = makeFetch({ "gen-1.webm": clipBytes(10, 4) })
    const fallback = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "gen-1", "webm", {}, "selectedGeneratedVoiceAudioId")],
      fetchBytes: missingSibling.fetchBytes,
    }))
    expect(missingSibling.calls).toEqual(["gen-1.wav", "gen-1.webm"])
    expect(fallback.entries.map((e) => e.name)).toEqual(["000_c1_Mary.webm"])
    expect(fallback.skipped).toEqual([]) // a sibling miss is not a skipped clip
  })

  it("records skips (no audio, fetch failure) and still completes with the rest", async () => {
    const { fetchBytes } = makeFetch({ "a1.mp3": clipBytes(10, 6) }) // a2 missing → 404
    const result = await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "a1", "mp3"), cell({ id: "c-text" }), audioCell("c2", "a2", "mp3")],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.mp3"])
    expect(result.skipped).toEqual([
      { cellId: "c-text", reason: "no audio" },
      { cellId: "c2", reason: expect.stringContaining("404") },
    ])
  })

  it("reports per-clip progress and aborts between clips with an AbortError", async () => {
    const { fetchBytes } = makeFetch({ "a1.mp3": clipBytes(10, 6), "a2.mp3": clipBytes(10, 6) })
    const progress: [number, number][] = []
    await assembleAudioEntries(baseArgs({
      cells: [audioCell("c1", "a1", "mp3"), audioCell("c2", "a2", "mp3")],
      fetchBytes,
      onProgress: (done, total) => progress.push([done, total]),
    }))
    expect(progress).toEqual([[1, 2], [2, 2]])

    const controller = new AbortController()
    await expect(
      assembleAudioEntries(baseArgs({
        cells: [audioCell("c1", "a1", "mp3"), audioCell("c2", "a2", "mp3")],
        fetchBytes,
        signal: controller.signal,
        onProgress: (done) => { if (done === 1) controller.abort() },
      })),
    ).rejects.toMatchObject({ name: "AbortError" })
  })
})

describe("assembleAudioEntries — file-clip", () => {
  it("concatenates every cell's post-trim audio into one <fileSlug>_all.wav", async () => {
    const { fetchBytes } = makeFetch({
      "a1.webm": clipBytes(10, 100),
      "a2.webm": clipBytes(20, 480),
    })
    const result = await assembleAudioEntries(baseArgs({
      mode: "file-clip",
      cells: [
        audioCell("c1", "a1", "webm"),
        audioCell("c2", "a2", "webm", { trimStartMs: 2, trimEndMs: 7 }), // → 240 samples
        cell({ id: "c-text" }),
      ],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["genesis_all.wav"])
    expect(wavSampleCount(result.entries[0].data)).toBe(340) // 100 + 240, trims applied
    expect(result.skipped).toEqual([{ cellId: "c-text", reason: "no audio" }])
  })

  it("emits no entry when nothing decodes", async () => {
    const { fetchBytes } = makeFetch({})
    const result = await assembleAudioEntries(baseArgs({
      mode: "file-clip",
      cells: [audioCell("c1", "a1", "webm")],
      fetchBytes,
    }))
    expect(result.entries).toEqual([])
    expect(result.skipped).toEqual([{ cellId: "c1", reason: expect.stringContaining("404") }])
  })
})

describe("assembleAudioEntries — voice-clips", () => {
  it("concatenates per voice with trims applied, first-appearance order", async () => {
    const { fetchBytes } = makeFetch({
      "a1.webm": clipBytes(10, 480),
      "a2.webm": clipBytes(20, 150),
      "a3.webm": clipBytes(30, 60),
    })
    const result = await assembleAudioEntries(baseArgs({
      mode: "voice-clips",
      cells: [
        audioCell("c1", "a1", "webm", { trimStartMs: 2, trimEndMs: 7 }), // Mary, 240
        audioCell("c2", "a2", "webm"), // John, 150
        audioCell("c3", "a3", "webm"), // Mary, 60
      ],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["Mary.wav", "John.wav"])
    expect(wavSampleCount(result.entries[0].data)).toBe(300) // 240 + 60
    expect(wavSampleCount(result.entries[1].data)).toBe(150)
  })

  it("disambiguates same-named cast members with _2 suffixes", async () => {
    const twins: ProjectTtsSettings = {
      voices: [{ id: "v1", name: "Sam" }, { id: "v2", name: "Sam" }],
      castAssignments: { c1: "v1", c2: "v2" },
    }
    const { fetchBytes } = makeFetch({ "a1.webm": clipBytes(10, 10), "a2.webm": clipBytes(20, 10) })
    const result = await assembleAudioEntries(baseArgs({
      mode: "voice-clips",
      settings: twins,
      cells: [audioCell("c1", "a1", "webm"), audioCell("c2", "a2", "webm")],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["Sam.wav", "Sam_2.wav"])
  })
})

/** A placed clip as the assembler hands them to the timeline: PCM16 in blob
 *  storage, never a Float32Array (AQU-1862). */
function placedClip(
  cellId: string,
  voiceId: string,
  samples: number,
  value = 0,
): TimelineClip {
  return { cellId, voiceId, samples, data: new Blob([new Int16Array(samples).fill(value)]) }
}

async function pcm16Of(parts: readonly Blob[]): Promise<Int16Array> {
  const buf = await new Blob(parts as BlobPart[]).arrayBuffer()
  return new Int16Array(buf)
}

describe("voice-timeline", () => {
  it("buildTimeline places clips at cumulative document-order offsets", () => {
    const timeline = buildTimeline([
      placedClip("c1", "v-mary", 100),
      placedClip("c2", "v-john", 150),
      placedClip("c3", "v-mary", 50),
    ])
    expect(timeline.totalSamples).toBe(300)
    expect(timeline.placements.map((p) => p.offset)).toEqual([0, 100, 250])
  })

  it("writeTimelineTrackParts fills only that voice's spans, zeros elsewhere", async () => {
    const timeline = buildTimeline([
      placedClip("c1", "v-mary", 100, 500),
      placedClip("c2", "v-john", 150, 400),
      placedClip("c3", "v-mary", 50, 300),
    ])
    const mary = await pcm16Of(writeTimelineTrackParts(timeline, "v-mary"))
    expect(mary.length).toBe(300)
    expect(mary[0]).toBe(500)
    expect(mary[99]).toBe(500)
    expect(mary[100]).toBe(0) // silence while John speaks
    expect(mary[249]).toBe(0)
    expect(mary[250]).toBe(300)
  })

  it("emits a stem's silence in bounded chunks, never one full-length buffer", async () => {
    // A long middle clip by another voice is the gap that used to be allocated
    // whole on every other voice's stem (AQU-1862).
    const gap = SILENCE_CHUNK_SAMPLES * 2 + 5
    const timeline = buildTimeline([
      placedClip("c1", "v-mary", 1, 7),
      placedClip("c2", "v-john", gap, 9),
      placedClip("c3", "v-mary", 1, 7),
    ])
    const parts = writeTimelineTrackParts(timeline, "v-mary")
    const total = parts.reduce((n, b) => n + b.size, 0)
    expect(total).toBe(timeline.totalSamples * 2)
    // Every part Mary's stem allocates is a chunk or a clip, both bounded.
    expect(Math.max(...parts.map((b) => b.size))).toBeLessThanOrEqual(SILENCE_CHUNK_SAMPLES * 2)
    expect(parts.length).toBeGreaterThan(2)
  })

  it("emits equal-length stems per voice with clips at their offsets", async () => {
    const { fetchBytes } = makeFetch({
      "a1.webm": clipBytes(50, 100), // Mary
      "a2.webm": clipBytes(40, 150), // John
      "a3.webm": clipBytes(30, 50),  // Mary
    })
    const result = await assembleAudioEntries(baseArgs({
      mode: "voice-timeline",
      cells: [
        audioCell("c1", "a1", "webm"),
        audioCell("c2", "a2", "webm"),
        audioCell("c3", "a3", "webm"),
      ],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["Mary_timeline.wav", "John_timeline.wav"])
    // Identical length is the mode's contract — stems must line up in a DAW.
    expect(wavSampleCount(result.entries[0].data)).toBe(300)
    expect(wavSampleCount(result.entries[1].data)).toBe(300)

    const mary = await wavSamples(result.entries[0].data)
    const john = await wavSamples(result.entries[1].data)
    expect(mary[0]).not.toBe(0)
    expect(mary[150]).toBe(0) // John's span is silence on Mary's stem
    expect(mary[250]).not.toBe(0)
    expect(john[0]).toBe(0)
    expect(john[150]).not.toBe(0)
    expect(john[250]).toBe(0)
  })
})

// AQU-1862: an hour of audio is ~690 MB of Float32, so what the assembler is
// still HOLDING when it moves to the next clip is the whole bug. peakPcmBytes
// reports it; these lock it to roughly one clip in every mode.
describe("assembleAudioEntries — retained PCM is bounded by one clip", () => {
  const clips = { "a1.webm": clipBytes(50, 100), "a2.webm": clipBytes(40, 150), "a3.webm": clipBytes(30, 50) }
  const cells = [
    audioCell("c1", "a1", "webm"),
    audioCell("c2", "a2", "webm"),
    audioCell("c3", "a3", "webm"),
  ]
  /** Decoded Float32 (4 B) + its PCM16 copy (2 B) for the biggest clip. */
  const oneClipCeiling = 150 * 6
  const allClipsFloat32 = (100 + 150 + 50) * 4

  for (const mode of ["file-clip", "voice-clips", "voice-timeline"] as const) {
    it(`${mode} never retains more than the clip in flight`, async () => {
      const { fetchBytes } = makeFetch(clips)
      const result = await assembleAudioEntries(baseArgs({ mode, cells, fetchBytes }))
      expect(result.entries.length).toBeGreaterThan(0)
      expect(result.peakPcmBytes).toBeLessThanOrEqual(oneClipCeiling)
      expect(result.peakPcmBytes).toBeLessThan(allClipsFloat32)
    })
  }

  it("drops a clip shared by several cells once the last cell has had it", async () => {
    // Shared clips are decoded once and must not then sit in the cache for the
    // rest of the file — with 3 cells on one clip that is 3× the retention.
    const { fetchBytes, calls } = makeFetch({ "shared.webm": clipBytes(60, 200) })
    const result = await assembleAudioEntries(baseArgs({
      mode: "separate-clips",
      cells: [
        audioCell("c1", "shared", "webm", { trimStartMs: 1 }),
        audioCell("c2", "shared", "webm", { trimStartMs: 1 }),
        audioCell("c3", "shared", "webm", { trimStartMs: 1 }),
      ],
      fetchBytes,
    }))
    expect(calls).toEqual(["shared.webm"]) // one fetch+decode, as before
    expect(result.entries).toHaveLength(3)
    // 200 samples Float32 + the trimmed PCM16 copy of one cell's slice.
    expect(result.peakPcmBytes).toBeLessThanOrEqual(200 * 4 + 200 * 2)
  })
})
