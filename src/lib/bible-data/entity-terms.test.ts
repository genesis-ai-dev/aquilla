// AQU-1693: what "Add to terminology" in a Voices or Who's Who popover may do.
// Why each case matters:
//   • a participant already linked needs nothing, and a second entry would
//     compete with the first for his name;
//   • an entry that already names him by headword is LINKED, not duplicated,
//     and linking (a term.update) is offered only at the termbase floor, the
//     same bar the server applies; below it there is no action at all;
//   • a local participant has no ACAI id that means the same person in every
//     book, so nothing can be linked.
import { describe, expect, it } from "vitest"
import type { Concept } from "@/lib/terminology/types"
import { JESUS, SAMARITAN_WOMAN, jhn4People } from "./__fixtures__/jhn4"
import { entityTermAction, type EntityTermInputs } from "./entity-terms"

const { entities } = jhn4People()
const jesus = entities[JESUS]

const concept = (p: Partial<Concept>): Concept => ({
  id: "c-jesus",
  sourceTerm: "Jesus",
  renderings: [{ rendering: "Yesus", status: "preferred" }],
  status: "active",
  createdAt: "2026-10-06T00:00:00Z",
  ...p,
})
const inputs = (p: Partial<EntityTermInputs> = {}): EntityTermInputs => ({
  concepts: [],
  sourceLanguage: "eng",
  canAdd: true,
  canLink: true,
  ...p,
})

describe("entityTermAction", () => {
  it("adds a draft linked to the participant, headed by his source-language name", () => {
    expect(entityTermAction(jesus, inputs())).toEqual({
      kind: "add",
      draft: { sourceTerm: "Jesus", externalIds: { acai: JESUS } },
    })
  })

  it("drops ACAI's disambiguator from the headword", () => {
    const john = entities["person:John"]
    expect(entityTermAction(john, inputs())).toMatchObject({ draft: { sourceTerm: "John" } })
  })

  it("takes a naming word's lemma when the source language has no label (Greek), else the English name", () => {
    const greek = inputs({ sourceLanguage: null })
    expect(entityTermAction(jesus, { ...greek, lemma: "Ἰησοῦς" })).toMatchObject({ draft: { sourceTerm: "Ἰησοῦς" } })
    expect(entityTermAction(jesus, greek)).toMatchObject({ draft: { sourceTerm: "Jesus" } })
  })

  it("offers to link an active entry that names him, rather than add a second", () => {
    const named = concept({})
    expect(entityTermAction(jesus, inputs({ concepts: [named] }))).toEqual({
      kind: "link",
      concept: named,
      externalIds: { acai: JESUS },
    })
    // In a Greek source, by the lemma of the word that names him.
    const greekEntry = concept({ sourceTerm: "Ἰησοῦς" })
    expect(entityTermAction(jesus, inputs({ concepts: [greekEntry], sourceLanguage: null, lemma: "Ἰησοῦς" }))).toMatchObject({
      kind: "link",
      concept: greekEntry,
    })
  })

  it("offers nothing below the termbase floor when an entry already names him", () => {
    expect(entityTermAction(jesus, inputs({ concepts: [concept({})], canLink: false }))).toBeNull()
  })

  it("offers nothing once any entry links him, even a suggestion still in review", () => {
    expect(entityTermAction(jesus, inputs({ concepts: [concept({ status: "draft", externalIds: { acai: JESUS } })] }))).toBeNull()
  })

  it("does not take an entry linked to someone else as his", () => {
    const other = concept({ externalIds: { acai: "person:Jesus.1" } })
    expect(entityTermAction(jesus, inputs({ concepts: [other] }))).toMatchObject({ kind: "add" })
  })

  it("offers nothing for a local participant, or to someone who may not suggest terms", () => {
    expect(entityTermAction(entities[SAMARITAN_WOMAN], inputs())).toBeNull()
    expect(entityTermAction(jesus, inputs({ canAdd: false }))).toBeNull()
  })
})
