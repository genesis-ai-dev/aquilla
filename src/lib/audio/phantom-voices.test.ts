import { describe, expect, it } from "vitest"
import type { ProjectTtsSettings, Voice } from "@/lib/parsers/types"
import { PRESET_VOICES } from "@/lib/audio/voices"
import { isPhantomVoice, isVerseNamedVoice, prunePhantomVoices } from "@/lib/audio/phantom-voices"

const narrator: Voice = { ...PRESET_VOICES[0] }

function character(name: string, i: number): Voice {
  return { id: `char-${i}`, name, color: "#0e7490", provider: "inworld", voiceName: "Dennis" }
}

function phantom(book: string, chapter: number, verse: number): Voice {
  return { id: `ph-${book}-${chapter}-${verse}`, name: `${book} ${chapter}:${verse}`, color: "#475569" }
}

/** An iloko_ilo_the_chosen in miniature: the real cast, the phantoms, and
 *  assignments pointing at both. */
function ilokoShaped(): ProjectTtsSettings {
  const names = ["SIMON", "MARY MAGDALENE", "MATTHEW", "JESUS", "PETER", "ANDREW", "JOHN", "THOMAS", "NICODEMUS", "QUINTUS"]
  const characters = names.map((name, i) => character(name, i))
  const phantoms: Voice[] = []
  for (let i = 0; i < 500; i++) phantoms.push(phantom("MAT", 1 + Math.floor(i / 25), (i % 25) + 1))
  const castAssignments: Record<string, string> = {}
  characters.forEach((v, i) => {
    castAssignments[`cell-char-${i}`] = v.id
  })
  phantoms.forEach((v, i) => {
    castAssignments[`cell-ph-${i}`] = v.id
  })
  return {
    provider: "inworld",
    defaultVoiceId: narrator.id,
    voices: [narrator, ...characters, ...phantoms],
    castAssignments,
  }
}

describe("isVerseNamedVoice", () => {
  it("reads the shapes the migration minted", () => {
    for (const name of ["MAT 5:3", "mat 5:3", "1CH 1:1", "GEN 1:1-3", " LUK 2:14 "]) {
      expect(isVerseNamedVoice(name), name).toBe(true)
    }
  })

  it("is not a verse reference", () => {
    for (const name of [
      undefined,
      "",
      "Narrator",
      "MARY MAGDALENE",
      "JESUS",
      "GEN 1", // chapter only — a shape a person might name something
      "ABC 1:1", // not a book in the canon
      "Speaker 1",
      "SIMON 2", // a cast sheet's second Simon
    ]) {
      expect(isVerseNamedVoice(name), String(name)).toBe(false)
    }
  })
})

describe("isPhantomVoice keep rules", () => {
  it("drops a bare verse-named voice", () => {
    expect(isPhantomVoice(phantom("MAT", 5, 3), "preset-narrator")).toBe(true)
  })

  it("keeps a built-in preset", () => {
    expect(isPhantomVoice({ ...phantom("MAT", 5, 3), builtIn: true }, "other")).toBe(false)
  })

  it("keeps the project default voice", () => {
    const voice = phantom("MAT", 5, 3)
    expect(isPhantomVoice(voice, voice.id)).toBe(false)
  })

  it("keeps a verse-named voice that someone configured", () => {
    const configured: Partial<Voice>[] = [
      { provider: "inworld" },
      { voiceName: "Dennis" },
      { model: "inworld-tts-2" },
      { referenceAudioId: "clone.wav" },
      { referenceTakeKey: "cell-1:0" },
      { designPreviewAudioId: "preview.wav" },
      { accent: "Ilocano" },
      { prompt: "Read this gently." },
      { speakingRate: 1.1 },
      { language: "ilo" },
    ]
    for (const extra of configured) {
      const voice = { ...phantom("MAT", 5, 3), ...extra }
      expect(isPhantomVoice(voice, "preset-narrator"), JSON.stringify(extra)).toBe(false)
    }
  })

  it("ignores a field that is merely present as undefined", () => {
    const voice: Voice = { ...phantom("MAT", 5, 3), provider: undefined, accent: undefined }
    expect(isPhantomVoice(voice, "preset-narrator")).toBe(true)
  })
})

describe("prunePhantomVoices", () => {
  it("strips the verse-named cast off an iloko-shaped library", () => {
    const settings = ilokoShaped()
    const result = prunePhantomVoices(settings)

    expect(result.clean).toBe(false)
    expect(result.totalVoices).toBe(511)
    expect(result.keptVoices).toBe(11)
    expect(result.droppedVoices).toBe(500)
    expect(result.next.voices?.map((v) => v.name)).toEqual([
      "Narrator",
      "SIMON", "MARY MAGDALENE", "MATTHEW", "JESUS", "PETER",
      "ANDREW", "JOHN", "THOMAS", "NICODEMUS", "QUINTUS",
    ])

    expect(result.totalAssignments).toBe(510)
    expect(result.droppedAssignments).toBe(500)
    expect(Object.keys(result.next.castAssignments ?? {})).toHaveLength(10)
    expect(result.next.castAssignments?.["cell-char-3"]).toBe("char-3")
    expect(result.next.castAssignments?.["cell-ph-0"]).toBeUndefined()

    expect(result.next.defaultVoiceId).toBe("preset-narrator")
    expect(result.next.provider).toBe("inworld")
    expect(result.sampleDroppedNames).toEqual(["MAT 1:1", "MAT 1:2", "MAT 1:3", "MAT 1:4", "MAT 1:5"])
  })

  it("leaves the input untouched", () => {
    const settings = ilokoShaped()
    const before = JSON.stringify(settings)
    prunePhantomVoices(settings)
    expect(JSON.stringify(settings)).toBe(before)
  })

  it("reports a clean library as clean and returns it unchanged", () => {
    const settings: ProjectTtsSettings = {
      defaultVoiceId: narrator.id,
      voices: [narrator, character("JESUS", 0)],
      castAssignments: { "cell-1": "char-0" },
    }
    const result = prunePhantomVoices(settings)
    expect(result.clean).toBe(true)
    expect(result.droppedVoices).toBe(0)
    expect(result.droppedAssignments).toBe(0)
    expect(result.totalVoices).toBe(2)
    expect(result.next).toBe(settings)
  })

  it("keeps a verse-named default voice and the assignments pointing at it", () => {
    const defaulted = phantom("MAT", 5, 3)
    const result = prunePhantomVoices({
      defaultVoiceId: defaulted.id,
      voices: [defaulted, phantom("MAT", 5, 4)],
      castAssignments: { "cell-1": defaulted.id, "cell-2": "ph-MAT-5-4" },
    })
    expect(result.keptVoices).toBe(1)
    expect(result.droppedVoices).toBe(1)
    expect(result.next.voices?.map((v) => v.id)).toEqual([defaulted.id])
    expect(result.next.castAssignments).toEqual({ "cell-1": defaulted.id })
  })

  it("treats an absent or empty library as clean", () => {
    expect(prunePhantomVoices(undefined).clean).toBe(true)
    expect(prunePhantomVoices(undefined).next).toEqual({})
    expect(prunePhantomVoices({ voices: [] }).clean).toBe(true)
    expect(prunePhantomVoices({}).next.voices).toBeUndefined()
  })

  it("does not invent a castAssignments key", () => {
    const result = prunePhantomVoices({ voices: [narrator, phantom("MAT", 5, 3)] })
    expect(result.clean).toBe(false)
    expect("castAssignments" in result.next).toBe(false)
  })

  it("leaves an already-dangling assignment alone", () => {
    const result = prunePhantomVoices({
      voices: [narrator, phantom("MAT", 5, 3)],
      castAssignments: { "cell-1": "gone-long-ago", "cell-2": "ph-MAT-5-3" },
    })
    expect(result.next.castAssignments).toEqual({ "cell-1": "gone-long-ago" })
    expect(result.droppedAssignments).toBe(1)
  })
})
