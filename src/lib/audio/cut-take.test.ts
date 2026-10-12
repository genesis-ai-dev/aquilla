// AQU-1767: the client's mirror of the server's cut rule, and piece names.
import { describe, it, expect } from "vitest"
import { CUT_MIN_PIECE_MS, canCutAt, newPieceAudioId, pieceLabels } from "./cut-take"
import { selectedDubTakes, selectedPieceIds, type CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

describe("canCutAt", () => {
  const take = { durationMs: 4000, role: "dub" as const }
  it("allows a cut at least CUT_MIN_PIECE_MS inside the audible window", () => {
    expect(canCutAt(take, 2000)).toBe(true)
    expect(canCutAt(take, CUT_MIN_PIECE_MS - 1)).toBe(false)
    expect(canCutAt(take, 4000 - CUT_MIN_PIECE_MS + 1)).toBe(false)
    expect(canCutAt({ ...take, trimStartMs: 1000, trimEndMs: 3000 }, 900)).toBe(false)
  })
  it("never cuts source audio, a take with no known end, or a missing take", () => {
    expect(canCutAt({ durationMs: 4000, role: "source" }, 2000)).toBe(false)
    expect(canCutAt({ role: "dub" }, 2000)).toBe(false)
    expect(canCutAt(undefined, 2000)).toBe(false)
  })
})

describe("piece names and ids", () => {
  it("numbers pieces from the group's base name, renaming the first only on the first cut", () => {
    expect(pieceLabels("a", { a: { label: "Take 3", slot: "recording" } })).toEqual({
      firstLabel: "Take 3 · 1",
      newLabel: "Take 3 · 2",
    })
    expect(
      pieceLabels("b", {
        a: { label: "Take 3 · 1", slot: "recording" },
        b: { label: "Take 3 · 2", slot: "recording", pieceOf: "a" },
      }),
    ).toEqual({ newLabel: "Take 3 · 3" })
  })
  it("mints a cell-seeded id that keeps the original's extension", () => {
    const id = newPieceAudioId("cell-9", "audio-cell-9-1-x.wav")
    expect(id).toMatch(/^audio-cell-9-\d+-[a-z0-9]+\.wav$/)
  })
})

describe("selection expands to pieces", () => {
  const entry: CellAudioEntry = {
    attachments: {
      a: { audioId: "a", url: "u", slot: "recording", mimeType: null, voiceId: null, referenceAudioId: null, durationMs: 4000, trimStartMs: null, trimEndMs: 1500, validatorCount: 1, role: "dub" },
      b: { audioId: "b", url: "u", slot: "recording", mimeType: null, voiceId: null, referenceAudioId: null, durationMs: 4000, trimStartMs: 1500, trimEndMs: null, validatorCount: 0, role: "dub", pieceOf: "a" },
      z: { audioId: "z", url: "v", slot: "recording", mimeType: null, voiceId: null, referenceAudioId: null, durationMs: 1000, trimStartMs: null, trimEndMs: null, role: "dub" },
    },
    selectedBySlot: { recording: "a" },
    selectedAudioId: "a",
    selectedGeneratedVoiceAudioId: null,
    audioTimings: {},
  }
  it("lists every piece of the selected take, in clip order, and not other takes", () => {
    expect(selectedPieceIds(entry.attachments, "a")).toEqual(["a", "b"])
    expect(selectedPieceIds(entry.attachments, "b")).toEqual(["a", "b"])
  })
  it("measures validation over every piece, so the weakest decides", () => {
    expect(selectedDubTakes(entry).map((t) => t.audioId)).toEqual(["a", "b"])
  })
})

describe("the gutter's take list sees every piece", () => {
  it("audioEntryFromCell keeps pieceOf and the window start, and drops removed pieces", async () => {
    const { audioEntryFromCell } = await import("./audio-validation-permissions")
    const entry = audioEntryFromCell({
      attachments: {
        a: { slot: "recording", role: "dub", trimStartMs: null, validatorCount: 1 },
        b: { slot: "recording", role: "dub", trimStartMs: 1500, pieceOf: "a", validatorCount: 0 },
        c: { slot: "recording", role: "dub", trimStartMs: 3000, pieceOf: "a", isDeleted: true },
      },
      selectedBySlot: { recording: "a" },
      selectedAudioId: "a",
    })!
    expect(selectedDubTakes(entry).map((t) => [t.audioId, t.validatorCount])).toEqual([["a", 1], ["b", 0]])
  })
})
