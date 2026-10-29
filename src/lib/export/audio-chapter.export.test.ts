import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import { exportAudioByChapter } from "./audio-chapter"
import { quantisePcm16 } from "@/lib/audio/wav-encode"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import type { CellData } from "@/hooks/useCells"

function cell(over: Partial<CellData>): CellData {
  return {
    id: "c", fileId: "f", original: "", translated: "", context: "", group: "",
    type: "verse", status: "unvalidated", validationStatus: "none",
    activeValidators: [], validationHistory: [], history: [], threads: [], ...over,
  }
}

const withTake = (id: string, ref: string, extra: Partial<CellData> = {}): CellData =>
  cell({
    id,
    group: ref,
    selectedAudioId: `a-${id}`,
    attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio/wav" } },
    ...extra,
  })

async function pcmFromWav(blob: Blob): Promise<number[]> {
  const buf = await blob.arrayBuffer()
  const view = new DataView(buf)
  const samples: number[] = []
  for (let i = 44; i < buf.byteLength; i += 2) samples.push(view.getInt16(i, true))
  return samples
}

describe("exportAudioByChapter", () => {
  it("writes verses back-to-back so playing the file is a continuous listen", async () => {
    const pcmById: Record<string, Float32Array> = {
      "a-v1": new Float32Array([0.5, 0.5]),
      "a-v2": new Float32Array([-0.5]),
      "a-v3": new Float32Array([0.25, 0.25, 0.25]),
    }
    const result = await exportAudioByChapter({
      cells: [withTake("v2", "MAT 1:2"), withTake("v1", "MAT 1:1"), withTake("v3", "MAT 1:3")],
      projectId: "p1",
      fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
      decode: async (bytes) => pcmById[new TextDecoder().decode(bytes)] ?? new Float32Array([0]),
    })
    expect(result.chapters).toBe(1)
    expect(result.extension).toBe("wav")
    expect(result.downloadSuffix).toBe("_MAT_1.wav")
    expect(result.skipped).toBe(0)
    const samples = await pcmFromWav(result.blob)
    expect(samples).toEqual([
      quantisePcm16(0.5), quantisePcm16(0.5),
      quantisePcm16(-0.5),
      quantisePcm16(0.25), quantisePcm16(0.25), quantisePcm16(0.25),
    ])
  })

  it("skips a missing verse without inserting silence", async () => {
    const pcmById: Record<string, Float32Array> = {
      "a-v1": new Float32Array([0.5]),
      "a-v3": new Float32Array([-0.5]),
    }
    const result = await exportAudioByChapter({
      cells: [
        withTake("v1", "MAT 1:1"),
        cell({ id: "v2", group: "MAT 1:2" }),
        withTake("v3", "MAT 1:3"),
      ],
      projectId: "p1",
      fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
      decode: async (bytes) => pcmById[new TextDecoder().decode(bytes)] ?? new Float32Array([0]),
    })
    expect(await pcmFromWav(result.blob)).toEqual([quantisePcm16(0.5), quantisePcm16(-0.5)])
  })

  it("zips one WAV per chapter when the file holds more than one", async () => {
    const result = await exportAudioByChapter({
      cells: [withTake("a", "MAT 1:1"), withTake("b", "MAT 2:1")],
      projectId: "p1",
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.extension).toBe("zip")
    expect(result.downloadSuffix).toBe("_audio-chapters.zip")
    expect(result.chapters).toBe(2)
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files).sort()).toEqual(["MAT_1.wav", "MAT_2.wav"])
  })

  it("prefers the lossless WAV sibling for generated webm clips", async () => {
    const fetched: string[] = []
    await exportAudioByChapter({
      cells: [
        cell({
          id: "v1",
          group: "MAT 1:1",
          selectedGeneratedVoiceAudioId: "gen-1.webm",
          attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
        }),
      ],
      projectId: "p1",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(fetched).toEqual(["gen-1.wav"])
  })

  it("falls back to the compressed bytes when the WAV sibling is missing", async () => {
    const fetched: string[] = []
    await exportAudioByChapter({
      cells: [
        cell({
          id: "v1",
          group: "MAT 1:1",
          selectedGeneratedVoiceAudioId: "gen-1.webm",
          attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
        }),
      ],
      projectId: "p1",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        if (ext === "wav") throw new Error("no sibling")
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(fetched).toEqual(["gen-1.wav", "gen-1.webm"])
  })

  it("applies the take's trim window so the stitch is what the line sounds like", async () => {
    // 1 second of PCM at 48 kHz. Trim to the middle 250–750 ms.
    const full = new Float32Array(TARGET_RATE)
    full.fill(0.5, 0, TARGET_RATE)
    full.fill(-0.5, Math.round(0.25 * TARGET_RATE), Math.round(0.75 * TARGET_RATE))
    const result = await exportAudioByChapter({
      cells: [
        withTake("v1", "MAT 1:1", {
          attachments: {
            "a-v1": {
              url: "frontier-audio://a-v1.wav",
              type: "audio/wav",
              trimStartMs: 250,
              trimEndMs: 750,
            },
          },
        }),
      ],
      projectId: "p1",
      fetchBytes: async () => new Uint8Array([1]),
      decode: async () => full,
    })
    const samples = await pcmFromWav(result.blob)
    expect(samples).toHaveLength(Math.round(0.5 * TARGET_RATE))
    expect(samples.every((s) => s === quantisePcm16(-0.5))).toBe(true)
  })

  it("refuses rather than handing over an empty file when nothing decoded", async () => {
    const result = await exportAudioByChapter({
      cells: [withTake("v1", "MAT 1:1")],
      projectId: "p1",
      fetchBytes: async () => new Uint8Array([]),
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.chapters).toBe(0)
    expect(result.clips).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.blob.size).toBe(0)
  })

  it("puts a chapter heading's samples ahead of the verses only when asked", async () => {
    const cells = [
      withTake("title", "", { type: "heading", group: "" }),
      withTake("v1", "GEN 1:1"),
      withTake("v2", "GEN 1:2"),
    ]
    const pcmById: Record<string, Float32Array> = {
      "a-title": new Float32Array([0.9]),
      "a-v1": new Float32Array([0.5]),
      "a-v2": new Float32Array([-0.5]),
    }
    const run = (includeChapterHeadings: boolean) =>
      exportAudioByChapter({
        cells,
        projectId: "p1",
        includeChapterHeadings,
        fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
        decode: async (bytes) => pcmById[new TextDecoder().decode(bytes)] ?? new Float32Array([0]),
      })
    const versesOnly = await run(false)
    expect(await pcmFromWav(versesOnly.blob)).toEqual([quantisePcm16(0.5), quantisePcm16(-0.5)])
    const withHeading = await run(true)
    expect(await pcmFromWav(withHeading.blob)).toEqual([
      quantisePcm16(0.9),
      quantisePcm16(0.5),
      quantisePcm16(-0.5),
    ])
  })

  it("counts a fetch failure as skipped rather than throwing", async () => {
    const result = await exportAudioByChapter({
      cells: [withTake("v1", "MAT 1:1"), withTake("v2", "MAT 1:2")],
      projectId: "p1",
      fetchBytes: async ({ audioId }) => {
        if (audioId === "a-v1") throw new Error("missing")
        return new TextEncoder().encode(audioId)
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.chapters).toBe(1)
    expect(result.skipped).toBe(1)
    expect(await pcmFromWav(result.blob)).toHaveLength(1)
  })
})

// AQU-1758 (Sam, Oct 29): on a book, a pause someone dragged open — before a
// verse's take, or between two pieces of a cut take — plays as silence in the
// app, so the chapter puts it in as silence and sounds like playback. Every
// piece of a cut take is in it, not just the first.
describe("exportAudioByChapter — a book's dragged-open pauses", () => {
  const MS = TARGET_RATE / 1000 // samples per millisecond
  const take = (id: string, ref: string, attachments: Record<string, unknown>) =>
    cell({ id, group: ref, selectedAudioId: Object.keys(attachments)[0], attachments: attachments as CellData["attachments"] })

  it("puts the pause before a verse's take in as silence", async () => {
    const result = await exportAudioByChapter({
      cells: [
        take("v1", "RUT 1:1", { "audio-v1-1700000000-take": { url: "frontier-audio://audio-v1-1700000000-take.wav", type: "audio", durationMs: 100, targetOffsetMs: 50 } }),
        withTake("v2", "RUT 1:2"),
      ],
      projectId: "p1",
      fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
      decode: async (bytes) =>
        new TextDecoder().decode(bytes) === "audio-v1-1700000000-take" ? new Float32Array(100 * MS).fill(0.5) : new Float32Array([0.25]),
    })
    const samples = await pcmFromWav(result.blob)
    expect(samples).toHaveLength(50 * MS + 100 * MS + 1)
    expect(samples.slice(0, 50 * MS).every((s) => s === 0)).toBe(true)
    expect(samples[50 * MS]).toBe(quantisePcm16(0.5))
    expect(samples.at(-1)).toBe(quantisePcm16(0.25))
  })

  it("puts every piece of a cut take in, with the silence dragged open between them", async () => {
    // One recording, 100 ms. Piece 1 is its 0–40 ms on the line's start;
    // piece 2 is its 60–100 ms, moved 60 ms along from the first piece's end
    // (to 100 ms): 60 ms of silence between.
    const recording = new Float32Array(100 * MS)
    recording.fill(0.5, 0, 50 * MS)
    recording.fill(-0.5, 50 * MS)
    const result = await exportAudioByChapter({
      cells: [
        take("v1", "RUT 1:1", {
          "audio-v1-1700000000-take": { url: "frontier-audio://audio-v1-1700000000-take.wav", type: "audio", durationMs: 100, trimEndMs: 40 },
          "audio-v1-1700000001-take": { url: "frontier-audio://audio-v1-1700000000-take.wav", type: "audio", durationMs: 100, trimStartMs: 60, pieceOf: "audio-v1-1700000000-take", targetOffsetMs: 60 },
        }),
      ],
      projectId: "p1",
      fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
      decode: async () => recording,
    })
    const samples = await pcmFromWav(result.blob)
    expect(samples).toHaveLength(40 * MS + 60 * MS + 40 * MS)
    expect(samples[0]).toBe(quantisePcm16(0.5))
    expect(samples.slice(40 * MS, 100 * MS).every((s) => s === 0)).toBe(true)
    expect(samples[100 * MS]).toBe(quantisePcm16(-0.5))
    expect(samples.at(-1)).toBe(quantisePcm16(-0.5))
  })
})

