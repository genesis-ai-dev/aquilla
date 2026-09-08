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
