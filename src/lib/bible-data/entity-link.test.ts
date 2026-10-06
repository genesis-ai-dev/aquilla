// AQU-1693: what Terminology's "Link to a Bible person, place or group" picker
// offers. Why these matter: a link must point at an id that means the same
// person in every book, and the person a translator is most likely after (the
// one named by the concept's headword) must be easy to find.
import { describe, expect, it } from "vitest"
import { JESUS, SAMARITAN_WOMAN, jhn4People } from "./__fixtures__/jhn4"
import { linkCandidates } from "./entity-link"

const { entities } = jhn4People()

describe("linkCandidates", () => {
  it("offers only entities ACAI knows: a local participant has no stable id to link", () => {
    const { suggested, others } = linkCandidates(entities, [], "")
    const ids = [...suggested, ...others].map((c) => c.id)
    expect(ids).toContain(JESUS)
    expect(ids).not.toContain(SAMARITAN_WOMAN)
    expect([...suggested, ...others].every((c) => c.acai === c.entity.acai)).toBe(true)
  })

  it("suggests the entity a label of which is the concept's headword or one of its forms", () => {
    expect(linkCandidates(entities, ["jesus"], "").suggested.map((c) => c.id)).toEqual([JESUS])
    // An Indonesian headword finds him through his Indonesian label.
    expect(linkCandidates(entities, ["Kristus", "Yesus"], "").suggested.map((c) => c.id)).toEqual([JESUS])
  })

  it("matches a headword without ACAI's disambiguator", () => {
    const john = linkCandidates(entities, ["John"], "").suggested.map((c) => c.entity.labels.eng)
    expect(john).toContain("John (the Baptist)")
  })

  it("filters by any label language or by id", () => {
    expect(linkCandidates(entities, [], "jésus").others.map((c) => c.id)).toEqual([JESUS])
    expect(linkCandidates(entities, [], "jesus.2").others.map((c) => c.id)).toEqual([JESUS])
    expect(linkCandidates(entities, [], "no such name")).toEqual({ suggested: [], others: [] })
  })
})
