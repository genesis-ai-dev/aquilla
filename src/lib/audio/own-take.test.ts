import { describe, expect, it } from "vitest"
import { isOwnSelection, isOwnTake, sharedSelections } from "./own-take"
import type { CellAudioEntry } from "@/lib/sync/cell-audio-read-types"

// AQU-2411. The ids are the shapes real takes carry:
const TAGGED = "audio-c1-1762300000000-abc123def" // recorded in Aquilla for line c1
const CODEX_OLD = "audio-1719100000000-k3j9x2m1p.webm" // Codex before Oct 2025: no line id
const CODEX_VERSE = "audio-gen-1:1-1730000000000-q8w7e6r5t.webm" // Codex Oct–Dec 2025
const SOURCE = "audio-f1-1762300000000-zzz999yyy" // the file's imported recording

const verse = { id: "c1", fileId: "f1" }
const section = { id: "c1", fileId: "f1", medium: "media" as const }

describe("isOwnTake", () => {
  it("counts a take tagged with the line's id, as before", () => {
    expect(isOwnTake(verse, TAGGED)).toBe(true)
    expect(isOwnTake(section, TAGGED)).toBe(true)
  })

  it("counts a take migrated from Codex on a text line", () => {
    expect(isOwnTake(verse, CODEX_OLD)).toBe(true)
    expect(isOwnTake(verse, CODEX_VERSE)).toBe(true)
    expect(isOwnTake({ ...verse, medium: "text" }, CODEX_OLD)).toBe(true)
  })

  it("never counts the file's imported recording or one marked as source", () => {
    expect(isOwnTake(verse, SOURCE)).toBe(false)
    expect(isOwnTake(verse, CODEX_OLD, { role: "source" })).toBe(false)
  })

  it("keeps the strict rule on a section of an imported recording", () => {
    expect(isOwnTake(section, CODEX_OLD)).toBe(false)
    expect(isOwnTake(section, SOURCE)).toBe(false)
  })

  it("has nothing to count without an id", () => {
    expect(isOwnTake(verse, null)).toBe(false)
    expect(isOwnTake(verse, "")).toBe(false)
  })
})

const entry = (selected: string, over: Partial<CellAudioEntry> = {}): CellAudioEntry => ({
  attachments: {
    [selected]: {
      audioId: selected, url: `r2://${selected}`, slot: "recording", mimeType: null, voiceId: null,
      referenceAudioId: null, durationMs: 3400, trimStartMs: null, trimEndMs: null,
    },
  },
  selectedAudioId: selected,
  selectedGeneratedVoiceAudioId: null,
  audioTimings: {},
  ...over,
})

describe("sharedSelections", () => {
  it("names the recordings chosen on more than one line", () => {
    const shared = sharedSelections([entry(SOURCE), entry(SOURCE), entry(CODEX_OLD)])
    expect([...shared]).toEqual([SOURCE])
  })

  it("reads every slot, and a line choosing one id twice is still one line", () => {
    const both = entry(CODEX_OLD, { selectedBySlot: { recording: CODEX_OLD, "track-2": CODEX_OLD } })
    expect(sharedSelections([both]).size).toBe(0)
    const other = entry(TAGGED, { selectedBySlot: { "track-2": CODEX_OLD } })
    expect([...sharedSelections([both, other])]).toEqual([CODEX_OLD])
  })
})

describe("isOwnSelection", () => {
  const att = (id: string, role?: "dub" | "source") => ({ ...entry(id).attachments[id], ...(role ? { role } : {}) })

  it("counts a Codex take chosen on its line alone", () => {
    expect(isOwnSelection("c1", CODEX_OLD, att(CODEX_OLD), new Set())).toBe(true)
  })

  it("never counts a recording chosen on several lines, or one marked source", () => {
    expect(isOwnSelection("c1", CODEX_OLD, att(CODEX_OLD), new Set([CODEX_OLD]))).toBe(false)
    expect(isOwnSelection("c1", CODEX_OLD, att(CODEX_OLD, "source"), new Set())).toBe(false)
  })

  it("counts a take tagged with the line's id whatever else is known", () => {
    expect(isOwnSelection("c1", TAGGED, undefined, null)).toBe(true)
  })

  it("keeps the strict rule when the file's other lines can't be seen", () => {
    expect(isOwnSelection("c1", CODEX_OLD, att(CODEX_OLD), null)).toBe(false)
  })

  it("does not count a chosen id with no recording behind it", () => {
    expect(isOwnSelection("c1", CODEX_OLD, undefined, new Set())).toBe(false)
  })
})
