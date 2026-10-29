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

  // AQU-1575: LOTE's broadcast vendor needs 16-bit / 48 kHz / mono WAV, and a
  // stored clip may be a 24 kHz WAV, a 22.05 kHz WAV or compressed webm. Asked
  // for WAV, nothing passes through as stored.
  it("writes every clip as a 16-bit, 48 kHz, mono WAV when WAV is asked for", async () => {
    const { calls, fetchBytes } = makeFetch({
      "a1.mp3": clipBytes(10, 6),
      "gen-1.wav": clipBytes(20, 8),
      "gen-1.webm": clipBytes(30, 4),
    })
    let decodes = 0
    const result = await assembleAudioEntries(baseArgs({
      audioFormat: "wav",
      cells: [
        audioCell("c1", "a1", "mp3"),
        audioCell("c2", "gen-1", "webm", {}, "selectedGeneratedVoiceAudioId"),
      ],
      fetchBytes,
      decode: async (b) => { decodes++; return fakeDecode(b) },
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.wav", "001_c2_John.wav"])
    // The generated clip still starts from its lossless copy.
    expect(calls).toEqual(["a1.mp3", "gen-1.wav"])
    expect(decodes).toBe(2)
    for (const entry of result.entries) {
      const dv = new DataView(await entry.data.arrayBuffer())
      expect(dv.getUint16(20, true)).toBe(1) // PCM
      expect(dv.getUint16(22, true)).toBe(1) // mono
      expect(dv.getUint32(24, true)).toBe(48_000)
      expect(dv.getUint16(34, true)).toBe(16)
    }
    expect(wavSampleCount(result.entries[0].data)).toBe(6)
    expect(wavSampleCount(result.entries[1].data)).toBe(8)
  })

  it("keeps passing stored clips through when the format is the original", async () => {
    const stored = clipBytes(10, 6)
    const { fetchBytes } = makeFetch({ "a1.mp3": stored })
    const result = await assembleAudioEntries(baseArgs({
      audioFormat: "original",
      cells: [audioCell("c1", "a1", "mp3")],
      fetchBytes,
    }))
    expect(result.entries.map((e) => e.name)).toEqual(["000_c1_Mary.mp3"])
    expect(new Uint8Array(await result.entries[0].data.arrayBuffer())).toEqual(stored)
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

// AQU-1758 (Sam, Oct 29): on a book, a pause someone dragged open — before a
// verse's take, or between two pieces of a cut take — plays as silence in the
// app, so every mode that joins a book's takes end to end puts it in as
// silence, and every piece of a cut take is in it.
describe("assembleAudioEntries — a book's dragged-open pauses", () => {
  const MS = TARGET_RATE / 1000
  // A take is the line's own when its id is seeded with the line's.
  const A1 = "audio-c1-1700000000-take", P1 = "audio-c2-1700000000-take", P2 = "audio-c2-1700000001-take"
  // c1 (Mary): a 100 ms take, 50 ms into its line → 50 + 100 ms.
  // c2 (John): a cut take of one 100 ms recording — 0–40 ms, then 60–100 ms
  // moved 60 ms along from the first piece's end → 40 + 60 (silence) + 40 ms.
  const book = () => [
    cell({
      id: "c1",
      selectedAudioId: A1,
      attachments: { [A1]: { url: `frontier-audio://${A1}.webm`, type: "audio/webm", durationMs: 100, targetOffsetMs: 50 } },
    }),
    cell({
      id: "c2",
      selectedAudioId: P1,
      attachments: {
        [P1]: { url: `frontier-audio://${P1}.webm`, type: "audio/webm", durationMs: 100, trimEndMs: 40 },
        [P2]: { url: `frontier-audio://${P1}.webm`, type: "audio/webm", durationMs: 100, trimStartMs: 60, pieceOf: P1, targetOffsetMs: 60 },
      } as unknown as CellData["attachments"],
    }),
  ]
  const clips = () => makeFetch({ [`${A1}.webm`]: clipBytes(50, 100 * MS), [`${P1}.webm`]: clipBytes(40, 100 * MS) })
  const C1 = (50 + 100) * MS
  const C2 = (40 + 60 + 40) * MS

  it("file-clip: the pause and the gap between pieces are silence; every piece is there", async () => {
    const { fetchBytes, calls } = clips()
    const result = await assembleAudioEntries(baseArgs({ mode: "file-clip", cells: book(), fetchBytes }))
    const s = await wavSamples(result.entries[0].data)
    expect(s.length).toBe(C1 + C2)
    expect(s.slice(0, 50 * MS).every((v) => v === 0)).toBe(true)
    expect(s[50 * MS]).not.toBe(0)
    expect(s[C1]).not.toBe(0) // piece 1
    expect(s.slice(C1 + 40 * MS, C1 + 100 * MS).every((v) => v === 0)).toBe(true)
    expect(s[C1 + 100 * MS]).not.toBe(0) // piece 2
    // The two pieces are one recording, fetched once.
    expect(calls.filter((c) => c === `${P1}.webm`)).toHaveLength(1)
  })

  it("voice-clips: each voice's line keeps its pause and its pieces", async () => {
    const { fetchBytes } = clips()
    const result = await assembleAudioEntries(baseArgs({ mode: "voice-clips", cells: book(), fetchBytes }))
    expect(result.entries.map((e) => e.name)).toEqual(["Mary.wav", "John.wav"])
    expect(wavSampleCount(result.entries[0].data)).toBe(C1)
    expect(wavSampleCount(result.entries[1].data)).toBe(C2)
  })

  it("voice-timeline: each line takes its whole length, pause and gaps included", async () => {
    const { fetchBytes } = clips()
    const result = await assembleAudioEntries(baseArgs({ mode: "voice-timeline", cells: book(), fetchBytes }))
    const mary = await wavSamples(result.entries[0].data)
    const john = await wavSamples(result.entries[1].data)
    expect(mary.length).toBe(C1 + C2)
    expect(john.length).toBe(C1 + C2)
    expect(mary[10]).toBe(0)
    expect(mary[50 * MS]).not.toBe(0)
    expect(john[C1]).not.toBe(0)
    expect(john[C1 + 50 * MS]).toBe(0)
    expect(john[C1 + 100 * MS]).not.toBe(0)
  })
})

