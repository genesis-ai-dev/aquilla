// AQU-1689 — Who's Who, the people index.
//
// Golden tests on real pack data (JHN 4, MRK 1; see __fixtures__/ATTRIBUTION.md).
// What they protect, in the translator's terms:
//   • a pronoun reached through a chain of references still lands on the
//     right person, and the chain length is kept, because a two-hop answer is
//     less certain than a direct one;
//   • a group ("they" = Jesus and four disciples) stays a group: it is never
//     counted as one of its members, so following Jesus never silently
//     includes "they";
//   • the cast of a passage is the passage's own (pericope, not chapter);
//   • previous/next mention jumps visit a participant's verses in order;
//   • the two flags fire where a translator has a real decision to make, and
//     stay quiet where they would only be noise.

import { describe, expect, it } from "vitest"
import {
  AUTON_4_10,
  DISCIPLES_4_8,
  JESUS,
  SAMARITAN_WOMAN,
  jhn4People,
  jhn4Structure,
  jhn4Text,
} from "./__fixtures__/jhn4"
import {
  ELTHON_1_29,
  JESUS_AND_FOUR,
  MOTHER_IN_LAW,
  PETER,
  mrk1People,
  mrk1Structure,
  mrk1Text,
} from "./__fixtures__/mrk1"
import { WATER, jhn4People11 } from "./__fixtures__/jhn4-pack11"
import type { BkpPeopleLayer, BkpStructureLayer } from "./pack-types"
import {
  adjacentMentionRef,
  buildPeopleIndex,
  mentionsEntity,
  pericopeAt,
  pericopeCast,
  peopleIndexFor,
  threadSlot,
  verseMentionsByEntity,
  type CastMember,
  type PeopleIndex,
} from "./people-index"

function jhn(): PeopleIndex {
  return buildPeopleIndex(jhn4People(), jhn4Structure(), jhn4Text())
}

function mrk(): PeopleIndex {
  return buildPeopleIndex(mrk1People(), mrk1Structure(), mrk1Text())
}

function castAt(index: PeopleIndex, ref: string): readonly CastMember[] {
  const pericope = pericopeAt(index, ref)
  if (!pericope) throw new Error(`no pericope for ${ref}`)
  return pericopeCast(index, pericope)
}

function member(cast: readonly CastMember[], entity: string): CastMember {
  const found = cast.find((m) => m.entity === entity)
  if (!found) throw new Error(`${entity} is not in the cast`)
  return found
}

describe("mentions in a verse", () => {
  it("keeps αὐτόν in JHN 4:10 on Jesus, two hops away", () => {
    const jesus = verseMentionsByEntity(jhn(), "JHN 4:10").get(JESUS) ?? []
    const auton = jesus.find((at) => at.wordId === AUTON_4_10)
    expect(auton?.mention).toMatchObject({ entity: JESUS, kind: "pronoun", src: "macula" })
    expect(auton?.mention.hops).toBeGreaterThanOrEqual(2)
  })

  it("groups a verse's mentions by participant, in word order", () => {
    const byEntity = verseMentionsByEntity(jhn(), "JHN 4:7")
    // γυνή, ἀντλῆσαι, αὐτῇ, Δός: one thread, four words.
    expect(byEntity.get(SAMARITAN_WOMAN)?.map((at) => at.mention.kind)).toEqual([
      "explicit",
      "subject",
      "pronoun",
      "subject",
    ])
    // Ἰησοῦς, μοι, πεῖν.
    expect(byEntity.get(JESUS)?.map((at) => at.mention.kind)).toEqual(["explicit", "pronoun", "subject"])
  })
})

describe("groups are never collapsed into a member", () => {
  it("resolves ἦλθον in MRK 1:29 to a group of five, not to Jesus", () => {
    const index = mrk()
    const elthon = (index.byVerse.get("MRK 1:29") ?? []).find((at) => at.wordId === ELTHON_1_29)
    expect(elthon?.mention.entity).toBe(JESUS_AND_FOUR)
    expect(index.entities[JESUS_AND_FOUR].members).toEqual([
      "person:Andrew",
      "person:James",
      JESUS,
      "person:John.2",
      PETER,
    ])
  })

  it("lists the group in the cast as a plural group with its members, and counts it apart from Jesus", () => {
    const cast = castAt(mrk(), "MRK 1:29")
    const group = member(cast, JESUS_AND_FOUR)
    expect(group.members).toHaveLength(5)
    expect(group.number).toBe("plural")
    // Every "they" verb of the group is the group's; none of them is Jesus's.
    const jesus = member(cast, JESUS)
    const groupWords = new Set(mrk().mentions.filter((at) => at.mention.entity === JESUS_AND_FOUR).map((at) => at.wordId))
    expect(groupWords.size).toBe(group.count)
    expect(mrk().mentions.filter((at) => at.mention.entity === JESUS && groupWords.has(at.wordId))).toEqual([])
    expect(jesus.count).toBeGreaterThan(0)
  })

  it("does not count a verse that mentions only the group as a verse that mentions Jesus", () => {
    // MRK 1:29 names Simon, Andrew, James and John, and "they" (the five).
    expect(mentionsEntity(mrk(), ["MRK 1:29"], JESUS)).toBe(false)
    expect(mentionsEntity(mrk(), ["MRK 1:29"], JESUS_AND_FOUR)).toBe(true)
    expect(mentionsEntity(mrk(), ["MRK 1:31"], JESUS)).toBe(true)
  })
})

describe("the cast of a pericope", () => {
  it("finds the passage a verse is in, from the pack's segments", () => {
    expect(pericopeAt(jhn(), "JHN 4:7")).toMatchObject({
      fromRef: "JHN 4:1",
      toRef: "JHN 4:26",
      title: "Christ and the Woman of Samaria",
    })
    expect(pericopeAt(jhn(), "JHN 4:27")?.fromRef).toBe("JHN 4:27")
    expect(pericopeAt(jhn(), "JHN 9:99")).toBeNull()
  })

  it("includes Jesus, the Samaritan woman and the disciples as a group in JHN 4:1–26", () => {
    const cast = castAt(jhn(), "JHN 4:10")
    const participants = cast.filter((m) => m.role === "participant").map((m) => m.entity)
    expect(participants).toEqual(expect.arrayContaining([JESUS, SAMARITAN_WOMAN, DISCIPLES_4_8]))

    const disciples = member(cast, DISCIPLES_4_8)
    expect(disciples.number).toBe("plural")
    expect(disciples.first.ref).toBe("JHN 4:8")

    const woman = member(cast, SAMARITAN_WOMAN)
    expect(woman).toMatchObject({ gender: "feminine", number: "singular" })
    expect(woman.first).toMatchObject({ ref: "JHN 4:7", wordId: "n43004007002" })
    expect(woman.kinds.explicit + woman.kinds.pronoun + woman.kinds.subject).toBe(woman.count)
    expect(member(cast, JESUS)).toMatchObject({ gender: "male", number: "singular" })
  })

  it("puts the most-mentioned participants first and lists places after every participant", () => {
    const cast = castAt(jhn(), "JHN 4:10")
    expect(cast.slice(0, 2).map((m) => m.entity).sort()).toEqual([JESUS, SAMARITAN_WOMAN].sort())
    const firstPlace = cast.findIndex((m) => m.role === "place")
    expect(firstPlace).toBeGreaterThan(0)
    expect(cast.slice(firstPlace).every((m) => m.role !== "participant")).toBe(true)
    expect(member(cast, "place:Samaria").role).toBe("place")
  })

  it("gives the six most-mentioned participants a thread color and the rest none", () => {
    const index = jhn()
    const participants = castAt(index, "JHN 4:10").filter((m) => m.role === "participant")
    expect(threadSlot(index, "JHN 4:10", participants[0].entity)).toBe(1)
    expect(threadSlot(index, "JHN 4:10", participants[5].entity)).toBe(6)
    expect(threadSlot(index, "JHN 4:10", participants[6].entity)).toBeNull()
    expect(threadSlot(index, "JHN 4:10", "place:Samaria")).toBeNull()
  })
})

describe("previous and next mention", () => {
  it("walks Jesus's mentions through JHN 4:6–4:10 in order", () => {
    const index = jhn()
    const refs = index.refsByEntity.get(JESUS) ?? []
    const at = (ref: string) => refs.indexOf(ref)
    expect(at("JHN 4:6")).toBeLessThan(at("JHN 4:7"))
    expect([at("JHN 4:7"), at("JHN 4:8"), at("JHN 4:9"), at("JHN 4:10")]).toEqual([
      at("JHN 4:6") + 1,
      at("JHN 4:6") + 2,
      at("JHN 4:6") + 3,
      at("JHN 4:6") + 4,
    ])

    expect(adjacentMentionRef(index, JESUS, ["JHN 4:6"], "next")).toBe("JHN 4:7")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:7"], "next")).toBe("JHN 4:8")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:9"], "next")).toBe("JHN 4:10")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:10"], "previous")).toBe("JHN 4:9")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:7"], "previous")).toBe("JHN 4:6")
  })

  it("skips verses that do not mention the participant, and compares verse numbers, not strings", () => {
    const index = jhn()
    // Jesus is not mentioned in 4:12; "4:11" < "4:9" as strings, but not as verses.
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:11"], "next")).toBe("JHN 4:13")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:13"], "previous")).toBe("JHN 4:11")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:9"], "next")).toBe("JHN 4:10")
  })

  it("counts a bridge cell from its first verse back and its last verse on", () => {
    const index = jhn()
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:7", "JHN 4:8"], "next")).toBe("JHN 4:9")
    expect(adjacentMentionRef(index, JESUS, ["JHN 4:7", "JHN 4:8"], "previous")).toBe("JHN 4:6")
  })

  it("has nowhere to go past the last mention", () => {
    const index = jhn()
    const refs = index.refsByEntity.get(JESUS) ?? []
    expect(adjacentMentionRef(index, JESUS, [refs[refs.length - 1]], "next")).toBeNull()
    expect(adjacentMentionRef(index, JESUS, [refs[0]], "previous")).toBeNull()
  })
})

describe("flags", () => {
  // Real data: JHN 4:27 opens the next pericope with "his disciples came";
  // αὐτοῦ ("his") is the first word there that refers to Jesus. A reader who
  // starts at 4:27 meets "his" before any name.
  it("asks to re-introduce Jesus where a pericope first refers to him with a pronoun", () => {
    const jesus = member(castAt(jhn(), "JHN 4:27"), JESUS)
    expect(jesus.flags).toContainEqual(
      expect.objectContaining({
        code: "reintroduce",
        at: expect.objectContaining({ wordId: "n43004027007", ref: "JHN 4:27" }),
      }),
    )
  })

  // Real data: MRK 1:21 begins "they go into Capernaum … he was teaching";
  // Jesus is first an implied subject (ἐδίδασκεν).
  it("asks to re-introduce a participant who is first only an implied subject", () => {
    const jesus = member(castAt(mrk(), "MRK 1:21"), JESUS)
    expect(jesus.flags.map((flag) => flag.code)).toContain("reintroduce")
    expect(jesus.first.mention.kind).toBe("subject")
  })

  it("does not flag a participant the pericope first names", () => {
    const woman = member(castAt(jhn(), "JHN 4:7"), SAMARITAN_WOMAN)
    expect(woman.flags.map((flag) => flag.code)).not.toContain("reintroduce")
  })

  // "Whoever drinks" (4:14): the pronoun ὅς is itself the referent's anchor.
  // There is nobody earlier to bring back, so a flag would only be noise.
  it("does not ask to re-introduce a pronoun that introduces its own referent", () => {
    const whoever = member(castAt(jhn(), "JHN 4:14"), "local:JHN:n43004014001")
    expect(whoever.first.mention.kind).toBe("pronoun")
    expect(whoever.flags.map((flag) => flag.code)).not.toContain("reintroduce")
  })

  // Real data, JHN 4:14: "whoever drinks of the water that I (Jesus) will
  // give him (αὐτῷ)". Jesus is "I" there, so "him" cannot be read as Jesus in
  // any language; only a third-person mention makes someone a rival.
  it("does not count the speaker, referred to as 'I', as a rival for 'him'", () => {
    const whoever = member(castAt(jhn(), "JHN 4:14"), "local:JHN:n43004014001")
    expect(whoever.flags).toEqual([])
    // Without the text layer the index cannot tell persons apart, and says so
    // the only way it can: it reads every mention as third person.
    const blind = buildPeopleIndex(jhn4People(), jhn4Structure(), null)
    expect(member(castAt(blind, "JHN 4:14"), "local:JHN:n43004014001").flags).toContainEqual(
      expect.objectContaining({ code: "possible-ambiguity", others: [JESUS] }),
    )
  })

  // Real data: MRK 1:30, "they speak to him (αὐτῷ) about her". The verse
  // also names Simon (Peter): two men, both singular, so in a language whose
  // pronouns do not tell them apart "him" may read as Simon.
  it("flags a pronoun when another participant of the same gender and number is active", () => {
    const jesus = member(castAt(mrk(), "MRK 1:30"), JESUS)
    const ambiguity = jesus.flags.find((flag) => flag.code === "possible-ambiguity")
    expect(ambiguity).toMatchObject({ at: { ref: "MRK 1:30", wordId: "n41001030010" }, others: [PETER] })
  })

  // Real data, JHN 4:11: "the woman says to him (αὐτῷ): Sir (Κύριε), you
  // have nothing to draw with". The pack keeps the vocative κύριε as its own
  // participant ("Sir"), who is in fact Jesus. A vocative addresses the
  // listener, so like "you" it is never a rival for "him".
  it("does not count a form of address ('Sir') as a rival for 'him'", () => {
    const index = jhn()
    const sir = "local:JHN:n43004011005"
    expect(verseMentionsByEntity(index, "JHN 4:11").get(sir)?.[0]).toMatchObject({ firstOrSecondPerson: true })
    const jesus = member(castAt(index, "JHN 4:11"), JESUS)
    const in411 = jesus.flags.filter((flag) => flag.code === "possible-ambiguity" && flag.at.ref === "JHN 4:11")
    expect(in411).toEqual([])
  })

  // Real data, JHN 4:27: "his (αὐτοῦ) disciples came ... yet no one (οὐδείς)
  // said ...". The pack keeps "no one" as a participant. A negative word
  // introduces nobody a pronoun could stand for, so it is never a rival.
  it("never offers 'no one' as a reading of a pronoun", () => {
    const index = jhn()
    const noOne = "local:JHN:n43004027014"
    expect(index.negativeReferents.has(noOne)).toBe(true)
    const jesus = member(castAt(index, "JHN 4:27"), JESUS)
    const citing = jesus.flags.filter((flag) => flag.code === "possible-ambiguity" && flag.others.includes(noOne))
    expect(citing).toEqual([])
    // Without the structure layer the index cannot know, and says so by
    // reading every participant as a possible rival.
    const blind = buildPeopleIndex(jhn4People(), null, jhn4Text())
    expect(blind.negativeReferents.size).toBe(0)
  })

  it("does not flag a pronoun whose gender already tells the participants apart", () => {
    // MRK 1:30 αὐτῆς ("her") is the mother-in-law; the only other woman? None.
    const motherInLaw = member(castAt(mrk(), "MRK 1:30"), MOTHER_IN_LAW)
    expect(motherInLaw.flags.filter((flag) => flag.code === "possible-ambiguity")).toEqual([])
    // JHN 4:7 αὐτῇ ("to her") with Jesus in the verse: a man and a woman.
    const woman = member(castAt(jhn(), "JHN 4:7"), SAMARITAN_WOMAN)
    const in47 = woman.flags.filter((flag) => flag.code === "possible-ambiguity" && flag.at.ref === "JHN 4:7")
    expect(in47).toEqual([])
  })
})

// Synthetic: pack slice 2 adds `local-thing`, and a later pack may add types
// this build has never seen. They must not break the index, must never be
// listed or flagged as people, and a mention of an entity the file does not
// define must not crash anything either.
describe("entity types this build does not know", () => {
  const people = {
    book: "JHN",
    entities: {
      "person:Jesus.2": jhn4People().entities[JESUS],
      "local:JHN:n43004010029": {
        type: "local-thing",
        gender: "neuter",
        genderSource: "grammatical",
        labels: { eng: "water" },
        labelSource: "gloss",
        anchor: "n43004010029",
      },
      "local:JHN:n43004010009": {
        type: "gift-of-god",
        labels: { eng: "gift" },
        labelSource: "gloss",
      },
    },
    mentions: {
      n43004010002: { entity: JESUS, kind: "explicit", src: "acai", hops: 0, conf: 0.9 },
      // A pronoun first: a person would be flagged here.
      n43004010007: { entity: "local:JHN:n43004010029", kind: "pronoun", src: "macula", hops: 1, conf: 0.8 },
      n43004010009: { entity: "local:JHN:n43004010009", kind: "subject", src: "macula", hops: 1, conf: 0.8 },
      n43004010029: { entity: "local:JHN:n43004010029", kind: "explicit", src: "macula", hops: 0, conf: 0.9 },
      n43004010030: { entity: "local:JHN:missing", kind: "pronoun", src: "macula", hops: 1, conf: 0.8 },
    },
  } as unknown as BkpPeopleLayer

  it("lists them after the participants, never flagged", () => {
    const cast = castAt(buildPeopleIndex(people, jhn4Structure()), "JHN 4:10")
    expect(cast[0].entity).toBe(JESUS)
    for (const entity of ["local:JHN:n43004010029", "local:JHN:n43004010009", "local:JHN:missing"]) {
      expect(member(cast, entity)).toMatchObject({ role: "other", flags: [], number: null })
    }
    expect(member(cast, "local:JHN:missing").info).toBeUndefined()
  })

  it("keeps pack 1.1's real local thing, water in JHN 4:10, out of the flags and thread colors", () => {
    const index = buildPeopleIndex(jhn4People11(), jhn4Structure())
    expect(index.entities[WATER].type).toBe("local-thing")
    expect(member(castAt(index, "JHN 4:10"), WATER)).toMatchObject({ role: "other", flags: [] })
    expect(threadSlot(index, "JHN 4:10", WATER)).toBeNull()
  })

  it("skips a mention record that is not one", () => {
    const broken = { ...people, mentions: { ...people.mentions, n43004010001: { kind: "explicit" } } }
    const index = buildPeopleIndex(broken as unknown as BkpPeopleLayer, null)
    expect(index.byVerse.get("JHN 4:10")?.map((at) => at.wordId)).not.toContain("n43004010001")
    // No structure layer: mentions still work, there is just no pericope.
    expect(index.pericopes).toEqual([])
    expect(pericopeAt(index, "JHN 4:10")).toBeNull()
  })
})

describe("peopleIndexFor", () => {
  it("builds once per pack version and book, and rebuilds for a different file", () => {
    const people = jhn4People()
    const structure: BkpStructureLayer = jhn4Structure()
    const text = jhn4Text()
    const first = peopleIndexFor("1.0.0", people, structure, text)
    expect(peopleIndexFor("1.0.0", people, structure, text)).toBe(first)
    expect(peopleIndexFor("1.0.0", jhn4People(), structure, text)).not.toBe(first)
    expect(peopleIndexFor("1.0.0", people, structure, null)).not.toBe(first)
    expect(peopleIndexFor("1.0.1", people, structure, text)).not.toBe(first)
  })
})
