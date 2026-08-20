import { describe, it, expect } from "vitest"
import { characterFileKey, groupAudioByCharacter, previewAudioByCharacter } from "./audio-by-character"
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
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm", durationMs: 1000 } } }),
      cell({ id: "c3", startTime: 5, endTime: 6.5, selectedAudioId: "a3", attachments: { a3: { url: "frontier-audio://a3.webm", type: "audio/webm", durationMs: 1500 } } }),
    ]
    const preview = previewAudioByCharacter(cells, SETTINGS)
    const mary = preview.find((p) => p.key === "v-mary")!
    expect(mary.clipCount).toBe(2)
    expect(mary.totalDurationMs).toBe(2500)
  })

  it("returns null totalDurationMs when any clip's attachment lacks durationMs", () => {
    const cells = [
      cell({ id: "c1", startTime: 1, endTime: 2, selectedAudioId: "a1", attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm", durationMs: 1000 } } }),
      // c3 attachment has no durationMs → total becomes unknown
      cell({ id: "c3", startTime: 5, endTime: 6, selectedAudioId: "a3", attachments: { a3: { url: "frontier-audio://a3.webm", type: "audio/webm" } } }),
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
  let at = 0
  const withAudio = (id: string) => {
    at += 10
    return cell({
      id,
      startTime: at,
      endTime: at + 2,
      selectedAudioId: `a-${id}`,
      attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.webm`, type: "audio/webm" } },
    })
  }

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

// ── Who is MISSING (the codex-editor lesson, 2026-08-18) ──────────────────
//
// The preview used to describe only what would be written, so a character with
// no takes at all simply was not in the list — you found out by opening the zip
// and noticing someone absent. codex-editor's export preview scans every
// labelled line whether or not it has audio, precisely so an unrecorded
// character is visible BEFORE the export.

describe("the preview names characters with nothing recorded", () => {
  const timed = (id: string, startTime: number, over: Partial<CellData> = {}) =>
    cell({ id, startTime, endTime: startTime + 2, ...over })
  const withAudio = (id: string, startTime: number) =>
    timed(id, startTime, {
      selectedAudioId: `a-${id}`,
      attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.webm`, type: "audio/webm", durationMs: 1000 } },
    })

  it("lists a character whose every line is still unrecorded", () => {
    const rows = previewAudioByCharacter(
      [withAudio("c1", 10), timed("c2", 20), timed("c3", 30)],
      SETTINGS,
      (c) => (c.id === "c1" ? "JESUS" : "THOMAS"),
    )
    const thomas = rows.find((r) => r.name === "THOMAS")!
    expect(thomas.clipCount).toBe(0)
    expect(thomas.missingCount).toBe(2)
  })

  it("counts a recorded line that cannot be placed separately from a missing one", () => {
    // No start time: there IS a take, it just has nowhere to go.
    const rows = previewAudioByCharacter(
      [
        cell({
          id: "c1",
          selectedAudioId: "a1",
          attachments: { a1: { url: "frontier-audio://a1.webm", type: "audio/webm" } },
        }),
        timed("c2", 20),
      ],
      SETTINGS,
      () => "JESUS",
    )
    expect(rows[0].untimedCount).toBe(1)
    expect(rows[0].missingCount).toBe(1)
    expect(rows[0].clipCount).toBe(0)
  })

  it("counts a take shared by several lines ONCE", () => {
    // A combined "voice together" clip is attached to every cell it covers.
    const shared = { url: "frontier-audio://combined.wav", type: "audio/wav", durationMs: 4000 }
    const rows = previewAudioByCharacter(
      [
        timed("c1", 10, { selectedAudioId: "combined", attachments: { combined: shared } }),
        timed("c2", 12, { selectedAudioId: "combined", attachments: { combined: shared } }),
      ],
      SETTINGS,
      () => "CROWD",
    )
    expect(rows[0].clipCount).toBe(1)
    expect(rows[0].totalDurationMs).toBe(4000)
  })
})

// ── A line nobody cast is not a character called Narrator ───────────────────
//
// `resolveCastVoice` falls back to the project's built-in Narrator for any
// cell with no assignment, so every unlabeled line used to collect under a
// row called "Narrator" — in this preview, in the project report Anna files
// per episode, and in a delivered track named `..._NARRATOR.wav`. In a
// document about who says what that reads as somebody's casting decision.
// Sam, on the first real report: there is no Narrator in this episode.

describe("lines nobody has cast", () => {
  const recorded = (id: string) =>
    cell({
      id,
      startTime: 1,
      endTime: 2,
      selectedAudioId: `a-${id}`,
      attachments: { [`a-${id}`]: { url: `frontier-audio://a-${id}.wav`, type: "audio/wav" } },
    })

  it("calls them what they are instead of naming a character", () => {
    const rows = previewAudioByCharacter([recorded("x1")], SETTINGS)
    expect(rows).toHaveLength(1)
    expect(rows[0].name).toBe("(no character assigned)")
    expect(rows[0].name).not.toBe("Narrator")
  })

  it("gathers all of them into one row rather than one per default voice", () => {
    const rows = previewAudioByCharacter([recorded("x1"), recorded("x2")], SETTINGS)
    expect(rows).toHaveLength(1)
    expect(rows[0].clipCount).toBe(2)
  })

  it("keeps a real assignment's own name — the Narrator is editable in place", () => {
    // Deciding "uncast" by matching the Narrator's identity would file every
    // line of a project that renames and genuinely uses it under "no character
    // assigned", which is the same lie in the opposite direction. The test is
    // whether an EXPLICIT assignment exists.
    const rows = previewAudioByCharacter([recorded("c1")], SETTINGS)
    expect(rows[0].name).toBe("Mary")
  })

  it("honours a cell's own voice choice as an assignment", () => {
    const rows = previewAudioByCharacter(
      [{ ...recorded("x1"), ttsSettings: { voiceId: "v-john" } } as CellData],
      SETTINGS,
    )
    expect(rows[0].name).toBe("John")
  })

  it("puts them after the cast, not in the middle of the list", () => {
    // Sorted by first appearance otherwise, so an uncast line early in the
    // episode would sit above every real character.
    const rows = previewAudioByCharacter([recorded("x1"), recorded("c1")], SETTINGS)
    expect(rows.map((r) => r.name)).toEqual(["Mary", "(no character assigned)"])
  })

  it("groups the takes for export under the same single key", () => {
    const groups = groupAudioByCharacter([recorded("x1"), recorded("x2")], SETTINGS)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe("NO_CHARACTER")
    expect(groups[0].clips).toHaveLength(2)
  })

  it("names the delivered track NO_CHARACTER, not the sanitised sentence", () => {
    // `characterKey("(no character assigned)")` would give
    // `no_character_assigned` — a mouthful in a folder of forty tracks.
    expect(characterFileKey("(no character assigned)")).toBe("NO_CHARACTER")
    expect(characterFileKey("NICODEMUS")).toBe("NICODEMUS")
  })
})
