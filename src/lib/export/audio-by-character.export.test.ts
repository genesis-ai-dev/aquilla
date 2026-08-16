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
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array([1, 2, 3, 4]),
      decode: async () => new Float32Array([0.1, 0.2, 0.3]),
    })
    expect(result.skipped).toBe(0)
    const zip = await JSZip.loadAsync(result.blob)
    const names = Object.keys(zip.files).sort()
    expect(names).toEqual(["Mary_swh.wav", "John_swh.wav"].sort())
  })

  it("prefers the lossless WAV sibling for generated webm clips, with fallback", async () => {
    const cells = [
      // Generated voice, compressed primary → the .wav sibling should be
      // fetched first (meeting 2026-08-05: exports are ALWAYS lossless).
      cell({
        id: "c1",
        selectedGeneratedVoiceAudioId: "gen-1.webm",
        attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
      }),
      // Mic take — webm too, but never eligible; fetched as-is.
      cell({
        id: "c2",
        selectedAudioId: "take-2.webm",
        attachments: { "take-2.webm": { url: "frontier-audio://take-2.webm", type: "audio/webm" } },
      }),
    ]
    const fetched: string[] = []
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.skipped).toBe(0)
    expect(fetched).toEqual(["gen-1.wav", "take-2.webm"])
  })

  it("falls back to the compressed bytes when the WAV sibling is missing", async () => {
    const cells = [
      cell({
        id: "c1",
        selectedGeneratedVoiceAudioId: "gen-1.webm",
        attachments: { "gen-1.webm": { url: "frontier-audio://gen-1.webm", type: "audio/webm" } },
      }),
    ]
    const fetched: string[] = []
    const result = await exportAudioByCharacter({
      cells,
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async ({ audioId, ext }) => {
        fetched.push(`${audioId}.${ext}`)
        if (ext === "wav") throw Object.assign(new Error("audio not found (404)"), { status: 404 })
        return new Uint8Array([1, 2, 3, 4])
      },
      decode: async () => new Float32Array([0.1]),
    })
    expect(result.skipped).toBe(0) // a sibling miss is not a skipped clip
    expect(fetched).toEqual(["gen-1.wav", "gen-1.webm"])
  })

  it("skips characters with no audio and reports zero entries cleanly", async () => {
    const result = await exportAudioByCharacter({
      cells: [cell({ id: "c1" })],
      settings: SETTINGS,
      projectId: "p1",
      langCode: "swh",
      fetchBytes: async () => new Uint8Array(),
      decode: async () => new Float32Array(),
    })
    expect(result.skipped).toBe(0)
    const zip = await JSZip.loadAsync(result.blob)
    expect(Object.keys(zip.files)).toHaveLength(0)
  })
})
