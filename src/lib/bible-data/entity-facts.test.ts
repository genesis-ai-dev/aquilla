// AQU-1689 — Who's Who, facts about one participant.
//
// What this protects: the implied-subject hint ("[he = Jesus]") must never
// guess. It names the pronoun only when the verb's person and number and the
// participant's gender settle it, and otherwise shows the name alone. And
// "names only" must mean participants the data actually names, never an
// unnamed one ("woman") just because it has a label.

import { describe, expect, it } from "vitest"
import { JESUS, SAMARITAN_WOMAN, jhn4People, jhn4Text } from "./__fixtures__/jhn4"
import { JESUS_AND_FOUR, mrk1People, mrk1Text } from "./__fixtures__/mrk1"
import { ISRAEL, JOSEPH_10, LEVI_3, jhn4People11 } from "./__fixtures__/jhn4-pack11"
import { entityKin, entityNumber, entityRole, genderClass, isNamedEntity, subjectPronoun } from "./entity-facts"
import type { BkpEntity } from "./pack-types"

describe("subjectPronoun", () => {
  const text = jhn4Text()
  const people = jhn4People()

  it("reads the person and number off the verb and the gender off the participant", () => {
    // Δός (4:7), "give": second person singular, said to the woman.
    expect(subjectPronoun(text.words.n43004007012, people.entities[SAMARITAN_WOMAN])).toBe("second-singular")
    // ἔδωκεν (4:10), "he would have given": Jesus.
    expect(subjectPronoun(text.words.n43004010026, people.entities[JESUS])).toBe("third-singular-masculine")
    // ἦλθον (MRK 1:29), "they came": a group.
    expect(subjectPronoun(mrk1Text().words.n41001029007, mrk1People().entities[JESUS_AND_FOUR])).toBe("third-plural")
  })

  it("names no pronoun for a verb that has no person", () => {
    // λέγων (4:10) is a participle, πεῖν (4:7) an infinitive.
    expect(subjectPronoun(text.words.n43004010016, people.entities[JESUS])).toBeNull()
    expect(subjectPronoun(text.words.n43004007014, people.entities[JESUS])).toBeNull()
  })

  it("names no pronoun for a third-person singular whose gender is unknown", () => {
    expect(subjectPronoun(text.words.n43004010026, { type: "deity", labels: { eng: "LORD" }, labelSource: "acai" })).toBeNull()
  })
})

describe("isNamedEntity", () => {
  it("counts ACAI entities and groups of named members as named, and unnamed participants as not", () => {
    expect(isNamedEntity(JESUS, jhn4People().entities)).toBe(true)
    expect(isNamedEntity(SAMARITAN_WOMAN, jhn4People().entities)).toBe(false)
    expect(isNamedEntity(JESUS_AND_FOUR, mrk1People().entities)).toBe(true)
    expect(isNamedEntity("person:Nobody", jhn4People().entities)).toBe(false)
  })
})

describe("roles, gender and number", () => {
  it("treats male and masculine (and female and feminine) as one for pronoun agreement", () => {
    expect(genderClass("male")).toBe(genderClass("masculine"))
    expect(genderClass("female")).toBe(genderClass("feminine"))
    expect(genderClass(null)).toBeNull()
  })

  it("makes groups plural and gives unknown types no role among people", () => {
    expect(entityNumber(mrk1People().entities[JESUS_AND_FOUR])).toBe("plural")
    expect(entityRole(undefined)).toBe("other")
    expect(entityRole({ type: "place", labels: {}, labelSource: "acai" })).toBe("place")
  })
})

// AQU-1695: pack 1.1's `kin`, on real data for John.
describe("entityKin", () => {
  const people = jhn4People11()

  it("lists Jacob's sons and Jesus's parents, relation by relation, in the pack's order", () => {
    expect(entityKin(people.entities[ISRAEL], people.entities)).toEqual([
      { relation: "offspring", ids: [JOSEPH_10, LEVI_3] },
    ])
    expect(entityKin(people.entities[JESUS], people.entities)).toEqual([
      { relation: "father", ids: ["person:Joseph.4"] },
      { relation: "mother", ids: ["person:Mary"] },
    ])
    // A local participant has no ACAI family.
    expect(entityKin(people.entities[SAMARITAN_WOMAN], people.entities)).toEqual([])
  })

  it("leaves out a relative the entity map lacks and anything that is not an id", () => {
    const israel = { ...people.entities[ISRAEL], kin: { offspring: [JOSEPH_10, "person:Nobody", 7], siblings: "x" } }
    expect(entityKin(israel as unknown as BkpEntity, people.entities)).toEqual([
      { relation: "offspring", ids: [JOSEPH_10] },
    ])
  })
})
