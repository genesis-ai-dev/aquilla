// The full-episode export (Wendi, 2026-11-17): ONE mono file, as long as the
// episode, every character's lines at their own timestamps. What she had
// before was the takes glued end to end — a twenty-minute file for a
// forty-minute episode, with nothing where it belongs.

import { describe, it, expect } from "vitest"
import { estimateEpisodeExport, exportAudioByCharacter, EXPORT_SECONDS_PER_TAKE } from "./audio-by-character"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
import { quantisePcm16 } from "@/lib/audio/wav-encode"
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
  voices: [{ id: "v-mary", name: "Mary" }, { id: "v-john", name: "John" }],
  castAssignments: { c1: "v-mary", c2: "v-john", c3: "v-mary" },
}

/** A tenth of a second of one constant level, so a sample says whose take it is. */
const TAKE_SAMPLES = TARGET_RATE / 10
const LEVELS: Record<string, number> = { a1: 0.25, a2: 0.5, a3: 0.125 }

function take(id: string) {
  return { [id]: { url: `frontier-audio://${id}.wav`, type: "audio/wav" } }
}

async function samplesOf(blob: Blob): Promise<Int16Array> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF")
  // 44-byte canonical PCM header, then the samples.
  return new Int16Array(bytes.buffer.slice(44))
}

async function exportEpisode(cells: CellData[]) {
  return exportAudioByCharacter({
    cells,
    singleTrack: true,
    settings: SETTINGS,
    projectId: "p1",
    langCode: "swh",
    fetchBytes: async ({ audioId }) => new TextEncoder().encode(audioId),
    decode: async (bytes) => new Float32Array(TAKE_SAMPLES).fill(LEVELS[new TextDecoder().decode(bytes)]),
  })
}

describe("full-episode export (one track)", () => {
  it("writes one WAV with each character's line at its own timestamp, silence between", async () => {
    const result = await exportEpisode([
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: take("a1") }),
      cell({ id: "c2", startTime: 3, endTime: 4, selectedAudioId: "a2", attachments: take("a2") }),
    ])
    expect(result.characters).toBe(1)
    const pcm = await samplesOf(result.blob)
    // Runs to the end of the last cue (4 s) plus the tail pad — NOT the 0.2 s
    // the two takes add up to, which is the crammed file this replaces.
    expect(pcm.length).toBe(4.25 * TARGET_RATE)
    expect(pcm[0]).toBe(0)
    expect(pcm[1 * TARGET_RATE]).toBe(quantisePcm16(0.25)) // Mary, at 1 s
    expect(pcm[2 * TARGET_RATE]).toBe(0) // nobody speaking
    expect(pcm[3 * TARGET_RATE]).toBe(quantisePcm16(0.5)) // John, at 3 s
    expect(pcm[3 * TARGET_RATE + TAKE_SAMPLES]).toBe(0)
  })

  it("mixes two characters who talk over each other instead of dropping one", async () => {
    const result = await exportEpisode([
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: take("a1") }),
      cell({ id: "c2", startTime: 1, endTime: 2, selectedAudioId: "a2", attachments: take("a2") }),
    ])
    const pcm = await samplesOf(result.blob)
    const both = pcm[1 * TARGET_RATE]
    expect(both).toBeGreaterThan(quantisePcm16(0.5))
    expect(both).toBeLessThanOrEqual(quantisePcm16(0.75))
  })

  it("leaves a line with no timing out and says so, rather than gluing it on", async () => {
    const result = await exportEpisode([
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: take("a1") }),
      cell({ id: "c3", selectedAudioId: "a3", attachments: take("a3") }),
    ])
    expect(result.untimed).toBe(1)
    const pcm = await samplesOf(result.blob)
    expect(pcm.length).toBe(2.25 * TARGET_RATE)
    expect(Array.from(pcm).includes(quantisePcm16(0.125))).toBe(false)
  })

  it("reports nothing to export when no line has a recording", async () => {
    const result = await exportEpisode([cell({ id: "c1", startTime: 1, endTime: 2 })])
    expect(result.characters).toBe(0)
    expect(result.clips).toBe(0)
  })
})

describe("full-episode estimate", () => {
  const cells = [
    cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: take("a1") }),
    cell({ id: "c2", startTime: 3, endTime: 4, selectedAudioId: "a2", attachments: take("a2") }),
    cell({ id: "c3", selectedAudioId: "a3", attachments: take("a3") }), // untimed: not placed
  ]

  // The number shown before exporting has to be the file you then get, or it
  // is worse than showing nothing.
  it("promises the length and size the export then writes", async () => {
    const estimate = estimateEpisodeExport(cells, SETTINGS)
    const result = await exportEpisode(cells)
    expect(estimate.clips).toBe(2)
    expect(estimate.durationSec).toBe(4.25)
    expect(estimate.bytes).toBe(result.blob.size)
    expect(estimate.exportSec).toBe(2 * EXPORT_SECONDS_PER_TAKE)
  })

  it("is empty when nothing can be placed", () => {
    expect(estimateEpisodeExport([cells[2]!], SETTINGS)).toMatchObject({ clips: 0, bytes: 0, durationSec: 0 })
  })
})

describe("cancelling a full-episode export", () => {
  it("stops between takes and hands back no file", async () => {
    const abort = new AbortController()
    let fetched = 0
    const run = exportAudioByCharacter({
      cells: [
        cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: take("a1") }),
        cell({ id: "c2", startTime: 3, endTime: 4, selectedAudioId: "a2", attachments: take("a2") }),
      ],
      singleTrack: true,
      signal: abort.signal,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId }) => {
        fetched += 1
        abort.abort() // cancelled while the first take is on its way
        return new TextEncoder().encode(audioId)
      },
      decode: async () => new Float32Array(TAKE_SAMPLES),
    })
    await expect(run).rejects.toMatchObject({ name: "AbortError" })
    expect(fetched).toBe(1)
  })
})
