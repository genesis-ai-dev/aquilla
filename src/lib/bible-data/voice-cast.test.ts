// AQU-1692 — adopting the voices as a dubbing project's cast, on the real
// RUT 1–2 voices of pack 1.2.0.
//
// A cast name on a line says who reads ALL of it. So a line is adopted only
// when exactly one voice reads it, the narrator counting as a voice; anything
// else would put one actor's name on another actor's words. A cast name the
// project already set is never replaced, and every line left out is listed,
// so the maintainer can see what still needs a name.

import { describe, expect, it } from "vitest"
import { rutVoices } from "./__fixtures__/ot-pack12"
import { buildVoiceIndex, sharedVerseRefs, type Voice } from "./voice-index"
import { planVoiceCast, type VoiceCastCell } from "./voice-cast"

const index = buildVoiceIndex(rutVoices())
const NAMES: Record<string, string> = { "person:Naomi": "Naomi", "person:Ruth": "Ruth", "person:Boaz": "Boaz" }
const nameOf = (voice: Voice): string | null =>
  voice.kind === "narrator" ? "Narrator" : (voice.speech.speaker ? NAMES[voice.speech.speaker] : undefined) ?? null

const cell = (ref: string, castName: string | null = null): VoiceCastCell => ({ cellId: ref, ref, castName })
const verses = (chapter: number, count: number) =>
  Array.from({ length: count }, (_, i) => cell(`RUT ${chapter}:${i + 1}`))
const ruth = [...verses(1, 22), ...verses(2, 23)]
const NONE: ReadonlySet<string> = new Set()

describe("planVoiceCast", () => {
  const plan = planVoiceCast(index, ruth, NONE, { kind: "chapter", chapter: "RUT 1" }, nameOf)
  const assigned = new Map(plan.assign.map((line) => [line.ref, line.castName]))

  it("adopts a line one voice reads, the narrator included", () => {
    expect(assigned.get("RUT 1:1")).toBe("Narrator")
    expect(assigned.get("RUT 1:12")).toBe("Naomi")
    expect(assigned.get("RUT 1:17")).toBe("Ruth")
  })

  it("lists, and does not adopt, a line where the narrator introduces a speaker", () => {
    expect(assigned.has("RUT 1:16")).toBe(false)
    expect(plan.several.find((line) => line.ref === "RUT 1:16")?.names).toEqual(["Narrator", "Ruth"])
  })

  it("stays in the chosen chapter, and takes the whole file when asked", () => {
    expect([...plan.assign, ...plan.several].every((line) => line.ref.startsWith("RUT 1:"))).toBe(true)
    const file = planVoiceCast(index, ruth, NONE, { kind: "file" }, nameOf)
    expect(file.assign.find((line) => line.ref === "RUT 2:9")?.castName).toBe("Boaz")
  })

  it("keeps a cast name the project already set, and lists it", () => {
    const cells = [cell("RUT 1:12", "Naomi (older)"), cell("RUT 1:13")]
    const kept = planVoiceCast(index, cells, NONE, { kind: "file" }, nameOf)
    expect(kept.kept).toEqual([{ cellId: "RUT 1:12", ref: "RUT 1:12", castName: "Naomi (older)" }])
    expect(kept.assign.map((line) => line.ref)).toEqual(["RUT 1:13"])
  })

  it("skips cells that share a verse, whose voices are the whole verse's", () => {
    const cells = [cell("RUT 1:12"), { ...cell("RUT 1:12"), cellId: "second half" }]
    const split = planVoiceCast(index, cells, sharedVerseRefs(cells), { kind: "file" }, nameOf)
    expect(split.assign).toEqual([])
    expect(split.approximate.map((line) => line.cellId)).toEqual(["RUT 1:12", "second half"])
  })

  it("lists a line whose one voice the data cannot name, rather than adopting a blank", () => {
    const unnamed = planVoiceCast(index, [cell("RUT 1:12")], NONE, { kind: "file" }, () => null)
    expect(unnamed.unnamed.map((line) => line.ref)).toEqual(["RUT 1:12"])
    expect(unnamed.assign).toEqual([])
  })
})
