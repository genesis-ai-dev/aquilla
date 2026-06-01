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
