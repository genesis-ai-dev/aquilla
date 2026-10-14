// AQU-1700 — Who's Who on the Old Testament, with real pack 1.2.0 data.
//
// What these tests protect, in the translator's terms:
//   • every OT mention lands in its verse: a Hebrew morpheme id has one more
//     digit than a Greek word id, and an implied article ends in "ה", and a
//     mention the index cannot place is silently lost;
//   • Ruth has passages (SIL OTN sections), so its cast is the passage's;
//   • Genesis has none in the pack, so its cast is the chapter's, with thread
//     colors, instead of nothing.

import { describe, expect, it } from "vitest"
import {
  LORD,
  NAOMI,
  RETURN_SECTION,
  RUTH,
  SERPENT,
  genPeople,
  genStructure,
  rutPeople,
  rutStructure,
  rutText,
} from "./__fixtures__/ot-pack12"
import { buildPeopleIndex, mentionsIn, pericopeAt, pericopeCast, threadSlot } from "./people-index"
import { refOfWord } from "./versification"

describe("OT word ids", () => {
  it("places Hebrew morphemes and implied articles in their verse, and Greek words as before", () => {
    expect(refOfWord("RUT", "o080010160052")).toBe("RUT 1:16")
    expect(refOfWord("RUT", "o080010010071ה")).toBe("RUT 1:1")
    expect(refOfWord("PSA", "o191191760011")).toBe("PSA 119:176")
    expect(refOfWord("JHN", "n43004010024")).toBe("JHN 4:10")
    // Neither scheme, or a Greek id one digit long: not a word.
    expect(refOfWord("RUT", "o08001016005")).toBeNull()
    expect(refOfWord("JHN", "n430040100241")).toBeNull()
  })

  it("indexes every mention of RUT 1–2, none dropped", () => {
    const people = rutPeople()
    const index = buildPeopleIndex(people, rutStructure(), rutText())
    expect(index.mentions).toHaveLength(Object.keys(people.mentions).length)
    // RUT 1:16 בִּי "me": Ruth, through the suffix ־ִי, in the first person.
    const me = mentionsIn(index, ["RUT 1:16"]).find((at) => at.wordId === "o080010160052")
    expect(me).toMatchObject({ ref: "RUT 1:16", mention: { entity: RUTH, kind: "pronoun" }, firstOrSecondPerson: true })
  })
})

describe("the passage a verse is in", () => {
  it("is Ruth's SIL OTN section, with its title, where the pack has sections", () => {
    const index = buildPeopleIndex(rutPeople(), rutStructure(), rutText())
    expect(pericopeAt(index, "RUT 1:16")).toMatchObject({
      id: RETURN_SECTION,
      kind: "segment",
      title: "Naomi returned to Bethlehem with Ruth",
      fromRef: "RUT 1:6",
      toRef: "RUT 1:22",
    })
    const participants = pericopeCast(index, pericopeAt(index, "RUT 1:16")!)
      .filter((member) => member.role === "participant")
      .map((member) => member.entity)
    // Naomi is the most mentioned in 1:6–22, then her daughters-in-law, then Ruth.
    expect(participants[0]).toBe(NAOMI)
    expect(participants).toContain(RUTH)
  })

  it("is the chapter in Genesis, which the pack gives no sections, with a cast and thread colors", () => {
    const structure = genStructure()
    // The data really has none: the fallback is for this, not for a missing layer.
    expect(structure.segments).toEqual([])
    const index = buildPeopleIndex(genPeople(), structure, null)
    const chapter = pericopeAt(index, "GEN 3:1")
    expect(chapter).toMatchObject({ kind: "chapter", title: "", fromRef: "GEN 3:1", toRef: "GEN 3:24" })
    expect(pericopeAt(index, "GEN 1:31")).toMatchObject({ fromRef: "GEN 1:1", toRef: "GEN 1:31" })
    // GEN 3's cast: Adam, the LORD God and the serpent, and only GEN 3's mentions.
    const cast = pericopeCast(index, chapter!)
    const participants = cast.filter((member) => member.role === "participant").map((member) => member.entity)
    expect(participants.slice(0, 2)).toEqual(["person:Adam", LORD])
    expect(participants).toContain(SERPENT)
    expect(cast.every((member) => member.first.ref.startsWith("GEN 3:"))).toBe(true)
    // "Always" highlights color the chapter's people like a pericope's.
    expect(threadSlot(index, "GEN 3:1", "person:Adam")).toBe(1)
  })

  it("is nothing when the structure layer did not load, as before", () => {
    const index = buildPeopleIndex(genPeople(), null, null)
    expect(index.pericopes).toEqual([])
    expect(pericopeAt(index, "GEN 3:1")).toBeNull()
  })
})
