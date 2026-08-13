// AQU-905 — timeline-placed per-voice audio export.
// Each character exports as one full-length track with their clips at their own
// timecodes and silence in the gaps, so the set aligns in an external editor.
import { describe, it, expect } from "vitest"
import JSZip from "jszip"
import {
  placePcmOnTimeline,
  hasTimecodes,
  episodeDurationSec,
  exportAudioByCharacter,
} from "./audio-by-character"
import { TARGET_RATE } from "@/lib/audio/decode-mono"
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

/** WAV byte length → sample count (44-byte header, 16-bit mono PCM). */
function wavSamples(bytes: Uint8Array): number {
  return (bytes.length - 44) / 2
}

describe("placePcmOnTimeline", () => {
  it("places each clip at its timecode with silence in the gaps", () => {
    const out = placePcmOnTimeline(
      [
        { pcm: new Float32Array([0.5, 0.5]), startSec: 0 },
        { pcm: new Float32Array([0.25]), startSec: 4 },
      ],
      1, // 1 sample per second keeps the arithmetic readable
      6,
    )
    expect(Array.from(out)).toEqual([0.5, 0.5, 0, 0, 0.25, 0])
  })

  it("runs the full episode length even when the last clip ends early", () => {
    const out = placePcmOnTimeline([{ pcm: new Float32Array([1]), startSec: 0 }], 1, 10)
    expect(out.length).toBe(10)
  })

  it("extends past the episode length rather than truncating a clip", () => {
    const out = placePcmOnTimeline([{ pcm: new Float32Array([1, 1, 1]), startSec: 4 }], 1, 5)
    expect(out.length).toBe(7)
  })

  it("appends untimed clips after the furthest-written sample instead of dropping them", () => {
    const out = placePcmOnTimeline(
      [
        { pcm: new Float32Array([0.5]), startSec: 2 },
        { pcm: new Float32Array([0.25]), startSec: null },
      ],
      1,
      0,
    )
    expect(Array.from(out)).toEqual([0, 0, 0.5, 0.25])
  })

  it("sums overlapping clips and clamps to [-1, 1]", () => {
    const out = placePcmOnTimeline(
      [
        { pcm: new Float32Array([0.8, -0.8]), startSec: 0 },
        { pcm: new Float32Array([0.5, -0.5]), startSec: 0 },
      ],
      1,
      0,
    )
    expect(Array.from(out)).toEqual([1, -1])
  })

  it("returns an empty track for no clips and no episode length", () => {
    expect(placePcmOnTimeline([], 1, 0).length).toBe(0)
  })
})

describe("hasTimecodes / episodeDurationSec", () => {
  it("detects timed files and reports the furthest timecode across all cells", () => {
    const cells = [
      cell({ id: "c1", startTime: 0, endTime: 2 }),
      cell({ id: "c2", startTime: 30, endTime: 42.5 }),
    ]
    expect(hasTimecodes(cells)).toBe(true)
    expect(episodeDurationSec(cells)).toBe(42.5)
  })

  it("reports untimed files as concat-layout with zero duration", () => {
    const cells = [cell({ id: "c1" }), cell({ id: "c2" })]
    expect(hasTimecodes(cells)).toBe(false)
    expect(episodeDurationSec(cells)).toBe(0)
  })
})

describe("exportAudioByCharacter — timeline layout", () => {
  const oneSecond = new Float32Array(TARGET_RATE)

  it("gives every voice a full-length track with clips at their timecodes", async () => {
    // Episode runs 0→10s. Mary speaks at 0s and 8s, John at 4s.
    const cells = [
      cell({
        id: "c1", startTime: 0, endTime: 1, selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } },
      }),
      cell({
        id: "c2", startTime: 4, endTime: 5, selectedAudioId: "a2",
        attachments: { a2: { url: "frontier-audio://a2.wav", type: "audio/wav" } },
      }),
      cell({
        id: "c3", startTime: 8, endTime: 10, selectedAudioId: "a3",
        attachments: { a3: { url: "frontier-audio://a3.wav", type: "audio/wav" } },
      }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond,
    })

    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files).sort()).toEqual(["John_swh.wav", "Mary_swh.wav"])

    // Both tracks are exactly the episode length (10s), not the sum of clips.
    for (const name of ["Mary_swh.wav", "John_swh.wav"]) {
      const bytes = await zip.file(name)!.async("uint8array")
      expect(wavSamples(bytes)).toBe(10 * TARGET_RATE)
    }
  })

  it("keeps concatenating when the file has no timecodes", async () => {
    const cells = [
      cell({
        id: "c1", selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } },
      }),
      cell({
        id: "c3", selectedAudioId: "a3",
        attachments: { a3: { url: "frontier-audio://a3.wav", type: "audio/wav" } },
      }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond,
    })
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files)).toEqual(["Mary_swh.wav"])
    // Both of Mary's clips back-to-back: 2s, no silence.
    const bytes = await zip.file("Mary_swh.wav")!.async("uint8array")
    expect(wavSamples(bytes)).toBe(2 * TARGET_RATE)
  })

  it("exports a cell that has audio but no text", async () => {
    const cells = [
      cell({
        id: "c1", startTime: 3, endTime: 4, original: "", translated: "",
        selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } },
      }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond,
    })
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files)).toEqual(["Mary_swh.wav"])
    const bytes = await zip.file("Mary_swh.wav")!.async("uint8array")
    // 3s of leading silence + the 1s clip.
    expect(wavSamples(bytes)).toBe(4 * TARGET_RATE)
  })

  it("honors an explicit episode length that outruns the last cue", async () => {
    const cells = [
      cell({
        id: "c1", startTime: 0, endTime: 1, selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } },
      }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      episodeSec: 20,
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => oneSecond,
    })
    const zip = await JSZip.loadAsync(result.blob)
    const bytes = await zip.file("Mary_swh.wav")!.async("uint8array")
    expect(wavSamples(bytes)).toBe(20 * TARGET_RATE)
  })

  it("drops a character whose clips all fail to decode rather than emitting silence", async () => {
    const cells = [
      cell({
        id: "c1", startTime: 0, endTime: 1, selectedAudioId: "a1",
        attachments: { a1: { url: "frontier-audio://a1.wav", type: "audio/wav" } },
      }),
      cell({
        id: "c2", startTime: 4, endTime: 5, selectedAudioId: "a2",
        attachments: { a2: { url: "frontier-audio://a2.wav", type: "audio/wav" } },
      }),
    ]
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId }) => {
        if (audioId === "a2") throw new Error("gone")
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => oneSecond,
    })
    expect(result.skipped).toBe(1)
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files)).toEqual(["Mary_swh.wav"])
  })
})
