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
