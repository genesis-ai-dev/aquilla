// AQU-1701: the participant questions — referent (P13), we_inclusive (P9),
// introduced (P11) — on real pack data (John) and the World English Bible.
//
// WHY: each question costs a Jev call and invites a false "no", so it is
// asked only where the pack says a reader could go wrong AND code cannot
// settle it: "he" only matters when two men are in the scene; "we" only needs
// Jev when the profile marks clusivity but lists no forms to check; a
// participant needs introducing only where a pericope starts with them by
// name. All three start in SHADOW: recorded, acted on by nothing.

import { describe, expect, it } from "vitest"
import type { LanguageProfile } from "../../../../db/shared/language-profile"
import type { DecideResult, JevAnswer } from "../jev/decide"
import { bibleQaTraceRow } from "./bible-deps"
import { ENGLISH_QUOTES, jhnBBibleData } from "./bible-test-helpers"
import {
  activeFailures,
  BIBLE_QA_MODES,
  judgeExpectations,
  judgmentConstraint,
  type BibleQaDecide,
  type BibleQaTrace,
  type JudgeCell,
} from "./judge-expectations"

const WEB: Record<string, string> = {
  "JHN 1:42": "He brought him to Jesus. Jesus looked at him and said, “You are Simon the son of Jonah. You shall be called Cephas” (which is by interpretation, Peter).",
  "JHN 1:43": "On the next day, he was determined to go out into Galilee, and he found Philip. Jesus said to him, “Follow me.”",
  "JHN 4:16": "Jesus said to her, “Go, call your husband, and come here.”",
  "JHN 4:22": "You worship that which you don’t know. We worship that which we know; for salvation is from the Jews.",
}

/** English, with the third-person forms that make a word "pronoun-like" for P13. */
const ENGLISH: LanguageProfile = {
  ...ENGLISH_QUOTES,
  pronouns: { thirdPerson: { genderOrClass: true, forms: ["he", "him", "his", "she", "her", "they", "them", "their"] } },
}

function scriptedJev(p: number): { decide: BibleQaDecide; calls: Parameters<BibleQaDecide>[0][] } {
  const calls: Parameters<BibleQaDecide>[0][] = []
  const decide: BibleQaDecide = async (input) => {
    calls.push(input)
    const answers: Record<string, JevAnswer> = {}
    for (const key of Object.keys(input.questions)) answers[key] = { kind: "noul", p }
    const result: DecideResult = { answers, decidedBy: "model", model: "typesafe/jev-1.13", usage: null }
    return result
  }
  return { decide, calls }
}

async function cellsFor(texts: Record<string, string>, profile: LanguageProfile): Promise<JudgeCell[]> {
  const data = await jhnBBibleData(Object.fromEntries(Object.keys(texts).map((ref) => [ref, `source ${ref}`])), profile)
  return Object.entries(texts).map(([ref, text]) => ({
    cellId: `c${ref}`,
    ref,
    source: `source ${ref}`,
    text,
    ...(data.expectations.get(`c${ref}`) ? { expectation: data.expectations.get(`c${ref}`) } : {}),
  }))
}

/** The questions one span asks, as `check: question` lines. */
async function asked(texts: Record<string, string>, profile: LanguageProfile): Promise<string[]> {
  const jev = scriptedJev(0.9)
  await judgeExpectations(await cellsFor(texts, profile), { profile, packVersion: "1.2.0", decide: jev.decide, cache: new Map() }, "s1")
  return Object.entries(jev.calls[0]?.questions ?? {}).map(([key, q]) => `${key}: ${String(q.instructions.question)}`)
}

describe("referent (P13): only where two or more active participants share gender and number", () => {
  it("asks about Andrew in JHN 1:42 ('He brought him to Jesus', among three men), and nothing in JHN 4:16 (a man and a woman)", async () => {
    const questions = await asked({ "JHN 1:42": WEB["JHN 1:42"], "JHN 4:16": WEB["JHN 4:16"] }, ENGLISH)
    expect(questions.filter((q) => q.includes("_referent"))).toEqual([
      "c0_referent: Is it clear in this translation that Andrew is the one who brought?",
    ])
  })

  it("asks nothing without a pronoun-like word: none in the text, or no third-person forms in the profile", async () => {
    const noPronoun = "Andrew brought Simon to Jesus."
    expect((await asked({ "JHN 1:42": noPronoun }, ENGLISH)).filter((q) => q.includes("_referent"))).toEqual([])
    expect((await asked({ "JHN 1:42": WEB["JHN 1:42"] }, ENGLISH_QUOTES)).filter((q) => q.includes("_referent"))).toEqual([])
  })

  it("lets code decide when the translation names the participant", async () => {
    const cells = await cellsFor({ "JHN 1:42": "Andrew brought him to Jesus." }, ENGLISH)
    const jev = scriptedJev(0.9)
    const result = await judgeExpectations(cells, { profile: ENGLISH, packVersion: "1.2.0", decide: jev.decide, cache: new Map() }, "s1")
    expect(result.judgments).toContainEqual(expect.objectContaining({ check: "referent", outcome: "pass", decidedBy: "code" }))
  })

  it("carries its own repair for an ACTIVE 'no'; shadow by default", async () => {
    expect(BIBLE_QA_MODES.referent).toBe("shadow")
    const cells = await cellsFor({ "JHN 1:42": WEB["JHN 1:42"] }, ENGLISH)
    const result = await judgeExpectations(
      cells,
      { profile: ENGLISH, packVersion: "1.2.0", decide: scriptedJev(0.05).decide, cache: new Map(), modes: { referent: "active" } },
      "s1",
    )
    const failure = activeFailures(result).find((j) => j.check === "referent")
    expect(failure && judgmentConstraint(failure, undefined)).toBe("Make clear that Andrew is the one who brought.")
  })
})

describe("we_inclusive (P9): only where code cannot decide", () => {
  const clusivity = (first: NonNullable<LanguageProfile["pronouns"]>["firstPersonPlural"]): LanguageProfile => ({
    ...ENGLISH_QUOTES,
    pronouns: { firstPersonPlural: first },
  })

  it("asks of JHN 4:22's exclusive 'we' when the profile marks clusivity but lists no forms — and a 'yes' fails", async () => {
    const profile = clusivity({ clusivity: true })
    const cells = await cellsFor({ "JHN 4:22": WEB["JHN 4:22"] }, profile)
    const jev = scriptedJev(0.9)
    const result = await judgeExpectations(cells, { profile, packVersion: "1.2.0", decide: jev.decide, cache: new Map(), modes: { we_inclusive: "active" } }, "s1")
    expect(jev.calls[0].questions.c0_we_inclusive.instructions).toMatchObject({ question: "Does 'we' here include the people being spoken to?" })
    const failure = activeFailures(result).find((j) => j.check === "we_inclusive")
    expect(failure && judgmentConstraint(failure, undefined)).toBe('Use the exclusive "we": it leaves out the people being spoken to.')
  })

  it("asks nothing when the forms are listed (P9 decides in code) or the language has one 'we'", async () => {
    const listed = clusivity({ clusivity: true, inclusive: ["yumi"], exclusive: ["mipela"] })
    expect((await asked({ "JHN 4:22": "Yupela i lotu. Mipela i lotu." }, listed)).filter((q) => q.includes("we_inclusive"))).toEqual([])
    expect((await asked({ "JHN 4:22": WEB["JHN 4:22"] }, clusivity({ clusivity: false }))).filter((q) => q.includes("we_inclusive"))).toEqual([])
  })
})

describe("introduced (P11): only at a first mention after a pericope boundary", () => {
  const unnamed = "On the next day, he was determined to go out into Galilee, and he found him. Jesus said to him, “Follow me.”"

  it("asks about Philip, named at the start of 'Jesus Calls Philip and Nathaniel', when the translation does not name him", async () => {
    const questions = await asked({ "JHN 1:43": unnamed }, ENGLISH_QUOTES)
    expect(questions.filter((q) => q.includes("_introduced"))).toEqual([
      "c0_introduced: Is Philip clearly identified by name or description in this verse of the translation?",
    ])
  })

  it("lets code decide when the translation names him (WEB), and asks nothing mid-pericope where nobody is new", async () => {
    const cells = await cellsFor({ "JHN 1:43": WEB["JHN 1:43"], "JHN 4:16": WEB["JHN 4:16"] }, ENGLISH_QUOTES)
    const result = await judgeExpectations(cells, { profile: ENGLISH_QUOTES, packVersion: "1.2.0", decide: scriptedJev(0.9).decide, cache: new Map() }, "s1")
    expect(result.judgments.filter((j) => j.check === "introduced")).toEqual([
      { cellId: "cJHN 1:43", check: "introduced", outcome: "pass", decidedBy: "code", mode: "shadow" },
    ])
  })

  it("is advisory: an ACTIVE 'no' is a finding, never a repair", async () => {
    const cells = await cellsFor({ "JHN 1:43": unnamed }, ENGLISH_QUOTES)
    const result = await judgeExpectations(
      cells,
      { profile: ENGLISH_QUOTES, packVersion: "1.2.0", decide: scriptedJev(0.05).decide, cache: new Map(), modes: { introduced: "active" } },
      "s1",
    )
    const failure = activeFailures(result).find((j) => j.check === "introduced")
    expect(failure).toBeDefined()
    expect(failure && judgmentConstraint(failure, undefined)).toBeNull()
  })
})

// WHY: shadow answers are how a maintainer judges a question before it may
// act, so each must reach the run's (maintainer-only) jev:bible-qa trace with
// the question asked, its mode and its certainty.
describe("shadow answers in the maintainer's trace", () => {
  it("records the P13, P9 and P11 questions and answers in the jev:bible-qa row", async () => {
    const profile: LanguageProfile = {
      ...ENGLISH_QUOTES,
      pronouns: { ...ENGLISH.pronouns, firstPersonPlural: { clusivity: true } },
    }
    const unnamed = "On the next day, he was determined to go out into Galilee, and he found him. Jesus said to him, “Follow me.”"
    const cells = await cellsFor({ "JHN 1:42": WEB["JHN 1:42"], "JHN 1:43": unnamed, "JHN 4:22": WEB["JHN 4:22"] }, profile)
    const traces: BibleQaTrace[] = []
    await judgeExpectations(
      cells,
      { profile, packVersion: "1.2.0", decide: scriptedJev(0.2).decide, cache: new Map(), record: (t) => traces.push(t) },
      "s1",
    )
    const row = bibleQaTraceRow(traces[0])
    expect(row.label).toBe("jev:bible-qa")
    expect(row.user).toContain("Is it clear in this translation that Andrew is the one who brought?")
    const output = JSON.parse(row.output ?? "{}") as { judgments: { check: string; mode: string; outcome: string; certainty: number }[] }
    expect(output.judgments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "referent", mode: "shadow", outcome: "fail", certainty: 0.6 }),
        expect.objectContaining({ check: "introduced", mode: "shadow", outcome: "fail" }),
        // An exclusive "we": a "no, it leaves them out" is the expected answer.
        expect.objectContaining({ check: "we_inclusive", mode: "shadow", outcome: "pass" }),
      ]),
    )
  })
})
