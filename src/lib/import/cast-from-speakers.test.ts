import { describe, it, expect } from "vitest"
import { buildCastAdditions, buildCastRemovals, castLikeSpeakers } from "./cast-from-speakers"
import type { ProjectTtsSettings } from "@/lib/parsers/types"

describe("buildCastAdditions", () => {
  it("creates one voice per new distinct speaker and assigns cells, reusing existing names", () => {
    const existing: ProjectTtsSettings = { voices: [{ id: "v-mary", name: "Mary", color: "#ec4899" }] }
    const result = buildCastAdditions(
      [
        { cellId: "c1", speaker: "Mary" },   // reuse existing
        { cellId: "c2", speaker: "John" },   // new
        { cellId: "c3", speaker: "John" },   // reuse the just-created John
        { cellId: "c4", speaker: undefined }, // no speaker → no assignment
      ],
      existing,
      () => "new-id",  // deterministic id minter for the test
    )
    // Mary already existed; only John is added.
    expect(result.voices.map((v) => v.name)).toEqual(["Mary", "John"])
    expect(result.castAssignments).toEqual({ c1: "v-mary", c2: "new-id", c3: "new-id" })
  })

  it("returns a no-op when there are no speakers, preserving the Narrator built-in as default", () => {
    // When the voice library is empty, getVoiceLibrary falls back to PRESET_VOICES (Narrator).
    // No new voices should be added, and castAssignments must be empty.
    const existing: ProjectTtsSettings = { voices: [] }
    const result = buildCastAdditions([{ cellId: "c1", speaker: undefined }], existing, () => "x")
    expect(result.castAssignments).toEqual({})
    // Narrator preset is preserved as library[0]; no custom voices added.
    expect(result.voices.every((v) => v.builtIn)).toBe(true)
    expect(result.voices.length).toBe(1)
  })
})

// AQU-813 regression guard: a Codex project whose audio carries no voice labels
// must not be imported as one fabricated "voice" per clip.
describe("castLikeSpeakers", () => {
  const pairsFrom = (labels: string[]) => labels.map((speaker, i) => ({ cellId: `c${i}`, speaker }))

  it("keeps a real cast — a few names recurring across many lines", () => {
    const pairs = pairsFrom(["MARY", "PETER", "MARY", "JOHN", "PETER", "MARY", "JOHN", "MARY"])
    expect(castLikeSpeakers(pairs)).toEqual(pairs)
  })

  it("drops the whole set when every clip carries its own label (no repetition)", () => {
    const pairs = pairsFrom(["E10_S01_0001", "E10_S01_0002", "E10_S01_0003", "E10_S01_0004"])
    expect(castLikeSpeakers(pairs)).toEqual([])
  })

  it("drops a mostly-unique set even when a couple of labels happen to repeat", () => {
    const pairs = pairsFrom(["a1", "a2", "a3", "a4", "a5", "a6", "a7", "a1", "a2"])
    expect(castLikeSpeakers(pairs)).toEqual([])
  })

  it("drops labels that are structurally identifiers, not names", () => {
    expect(castLikeSpeakers(pairsFrom(["1", "2", "3", "4", "5"]))).toEqual([])
    expect(castLikeSpeakers(pairsFrom(["00:01:23,456", "00:02:01,000", "00:03:11,500", "00:04:00,250"]))).toEqual([])
    expect(castLikeSpeakers(pairsFrom(["clip 1", "segment_2", "Cell-3", "take 4"]))).toEqual([])
    expect(castLikeSpeakers(pairsFrom(["e10_001.wav", "e10_002.wav", "e10_003.mp3", "e10_004.mp3"]))).toEqual([])
  })

  it("strips identifier labels but keeps the real names mixed in with them", () => {
    const pairs = [
      { cellId: "c0", speaker: "MARY" },
      { cellId: "c1", speaker: "12" },
      { cellId: "c2", speaker: "MARY" },
      { cellId: "c3", speaker: "clip 4" },
      { cellId: "c4", speaker: "PETER" },
      { cellId: "c5", speaker: "MARY" },
    ]
    expect(castLikeSpeakers(pairs)).toEqual([
      { cellId: "c0", speaker: "MARY" },
      { cellId: "c2", speaker: "MARY" },
      { cellId: "c4", speaker: "PETER" },
      { cellId: "c5", speaker: "MARY" },
    ])
  })

  it("trims labels and skips blank/absent ones", () => {
    const pairs = [
      { cellId: "c0", speaker: "  MARY  " },
      { cellId: "c1", speaker: "   " },
      { cellId: "c2", speaker: undefined },
      { cellId: "c3", speaker: "MARY" },
    ]
    expect(castLikeSpeakers(pairs)).toEqual([
      { cellId: "c0", speaker: "MARY" },
      { cellId: "c3", speaker: "MARY" },
    ])
  })

  it("keeps a small label set — too little signal to judge repetition", () => {
    const pairs = pairsFrom(["MARY", "PETER", "JOHN"])
    expect(castLikeSpeakers(pairs)).toEqual(pairs)
  })

  it("yields no phantom voices downstream for label-less imported audio", () => {
    const pairs = pairsFrom(["seg_01", "seg_02", "seg_03", "seg_04", "seg_05", "seg_06"])
    const result = buildCastAdditions(castLikeSpeakers(pairs), { voices: [] }, () => "x")
    expect(result.castAssignments).toEqual({})
    expect(result.voices.every((v) => v.builtIn)).toBe(true)
  })
})

// ── Clearing a character sheet (AQU-646, Sam 2026-08-20) ─────────────────
//
// "Removing a character sheet would just clear all characters on subtitles or
// all characters on audio." The cells are emptied by `cast.assign` events; this
// is the other half — what the project SETTINGS must look like afterwards, and
// the half that is easy to forget because nothing on screen points at it.

describe("buildCastRemovals", () => {
  const settings = (): ProjectTtsSettings => ({
    voices: [
      { id: "v-mary", name: "Mary", color: "#ec4899" },
      { id: "v-john", name: "John", color: "#3b82f6" },
    ],
    castAssignments: { s1: "v-mary", s2: "v-john", other: "v-mary" },
    characterResolutions: {
      "s1 q1": { name: { chose: "subtitle", rejected: "JOHN" }, at: 1 },
      "s2 q2": { camera: { chose: "audio", rejected: "off" }, at: 2 },
      "other q9": { name: { chose: "audio", rejected: "MARY" }, at: 3 },
    },
  })

  it("drops the cleared cells' voice assignments and leaves every other file's alone", () => {
    const out = buildCastRemovals(["s1", "s2"], settings())
    expect(out.castAssignments).toEqual({ other: "v-mary" })
  })

  it("keeps the cast list exactly as it was, so a re-import restores the same colours", () => {
    // THE decision, and the reason for it: `buildCastAdditions` matches by name
    // and reuses the entry it finds, so the roster surviving is what keeps Mary
    // pink across a clear and a re-import.
    const before = settings()
    const out = buildCastRemovals(["s1", "s2", "other"], before) as unknown as Record<string, unknown>
    expect(out.voices).toBeUndefined() // not ours to touch — saveTts must not receive it
    expect(before.voices).toEqual([
      { id: "v-mary", name: "Mary", color: "#ec4899" },
      { id: "v-john", name: "John", color: "#3b82f6" },
    ])
  })

  it("forgets a decision when either side of it was cleared", () => {
    // The subtitle side of "s1 q1" and the CUE side of "s2 q2" — a resolution
    // is about two cells disagreeing, so emptying either one ends the argument.
    const out = buildCastRemovals(["s1", "q2"], settings())
    expect(Object.keys(out.characterResolutions)).toEqual(["other q9"])
  })

  it("does not mutate the settings it was handed", () => {
    const before = settings()
    buildCastRemovals(["s1"], before)
    expect(Object.keys(before.castAssignments!)).toEqual(["s1", "s2", "other"])
    expect(Object.keys(before.characterResolutions!)).toHaveLength(3)
  })

  it("survives a project that has never had either", () => {
    const out = buildCastRemovals(["s1"], undefined)
    expect(out).toEqual({ castAssignments: {}, characterResolutions: {} })
  })
})
