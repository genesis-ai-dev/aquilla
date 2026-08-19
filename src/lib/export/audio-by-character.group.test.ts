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
    const mary = groups.find((g) => g.key === "v-mary")!
    const john = groups.find((g) => g.key === "v-john")!
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
    const mary = preview.find((p) => p.key === "v-mary")!
    expect(mary.clipCount).toBe(2)
    expect(mary.totalDurationMs).toBe(2500)
  })

  it("returns null totalDurationMs when any clip's attachment lacks durationMs", () => {
    const cells = [
      cell({ id: "c1", selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm", durationMs: 1000 } } }),
      // c3 attachment has no durationMs → total becomes unknown
      cell({ id: "c3", selectedAudioId: "a3", attachments: { a3: { url: "frontier-audio://a3.webm", type: "audio/webm" } } }),
    ]
    const preview = previewAudioByCharacter(cells, SETTINGS)
    const mary = preview.find((p) => p.key === "v-mary")!
    expect(mary.clipCount).toBe(2)
    expect(mary.totalDurationMs).toBeNull()
  })
})

// ── Naming the character the way the app does ────────────────────────────
//
// Grouping used to go straight to `resolveCastVoice`, which reads
// `castAssignments`. Right when the AUDIO sheet was imported (it writes
// assignments for cue ids); silently wrong when only the SUBTITLE sheet was,
// because a cue then has no assignment of its own and every take collapses
// into one default-voice group.

describe("grouping by the resolved character name", () => {
  const withAudio = (id: string) =>
    cell({ id, selectedAudioId: `a-${id}`, attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.webm`, type: "audio/webm" } } })

  it("groups by NAME when a resolver supplies one, across different voices", () => {
    // Two cells the voice map disagrees about, one character. The name wins.
    const groups = groupAudioByCharacter(
      [withAudio("c1"), withAudio("c2")],
      SETTINGS,
      () => "NICODEMUS",
    )
    expect(groups).toHaveLength(1)
    expect(groups[0].name).toBe("NICODEMUS")
    expect(groups[0].clips).toHaveLength(2)
  })

  it("falls back to the voice when nothing names the cell", () => {
    const groups = groupAudioByCharacter([withAudio("c1")], SETTINGS, () => null)
    expect(groups[0].key).toBe("v-mary")
    expect(groups[0].name).toBe("Mary")
  })

  it("keeps a cell whose name resolves to blank on the voice path", () => {
    const groups = groupAudioByCharacter([withAudio("c1")], SETTINGS, () => "   ")
    expect(groups[0].name).toBe("Mary")
  })

  it("separates two characters that share one voice", () => {
    // The default-voice collapse this exists to prevent: with only the
    // subtitle sheet imported every cue resolves to the same fallback voice.
    const groups = groupAudioByCharacter(
      [withAudio("c1"), withAudio("c2")],
      SETTINGS,
      (c) => (c.id === "c1" ? "JESUS" : "MARY MAGDALENE"),
    )
    expect(groups.map((g) => g.name)).toEqual(["JESUS", "MARY MAGDALENE"])
  })

  it("carries the resolved name into the preview", () => {
    const [p] = previewAudioByCharacter([withAudio("c1")], SETTINGS, () => "SIMON")
    expect(p.name).toBe("SIMON")
    expect(p.clipCount).toBe(1)
  })
})
