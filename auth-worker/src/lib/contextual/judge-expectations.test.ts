// AQU-1690: judgeExpectations — Jev only where code cannot decide, one
// batched call per span, abstain when unsure, and SHADOW by default.
//
// WHY: Jev's accuracy on low-resource target languages is unknown. Until a
// question has a shadow eval, its answers must be recorded and never acted
// on — a confident wrong "no" would redraft good text. And code must answer
// whatever code can: a Jev call per cell would burn the cap for nothing.

import { describe, expect, it, vi } from "vitest"
import {
  activeFailures,
  BIBLE_QA_MODES,
  judgeExpectations,
  judgmentConstraint,
  type BibleQaDecide,
  type BibleQaTrace,
  type JudgeCell,
} from "./judge-expectations"
import { ENGLISH_QUOTES, jhn4BibleData } from "./bible-test-helpers"
import type { DecideResult, JevAnswer } from "../jev/decide"
import type { LanguageProfile } from "../../../../db/shared/language-profile"

const CORRECT_4_9 =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria?” For Jews have no dealings with Samaritans."
const NEGATION_DROPPED_4_9 =
  "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me, a woman of Samaria?” For Jews have dealings with Samaritans."

/** A scripted Jev: answers each asked key with p, and records every call. */
function scriptedJev(p: (key: string) => number): { decide: BibleQaDecide; calls: Parameters<BibleQaDecide>[0][] } {
  const calls: Parameters<BibleQaDecide>[0][] = []
  const decide: BibleQaDecide = async (input) => {
    calls.push(input)
    const answers: Record<string, JevAnswer> = {}
    for (const key of Object.keys(input.questions)) answers[key] = { kind: "noul", p: p(key) }
    const result: DecideResult = { answers, decidedBy: "model", model: "typesafe/jev-1.13", usage: { input_tokens: 9, output_tokens: 2 } }
    return result
  }
  return { decide, calls }
}

async function cellsFor(texts: Record<string, string>, profile: LanguageProfile = ENGLISH_QUOTES): Promise<JudgeCell[]> {
  const data = await jhn4BibleData({ profile })
  return Object.entries(texts).map(([cellId, text]) => ({
    cellId,
    ref: null,
    source: `source ${cellId}`,
    text,
    facts: data.facts.get(cellId),
    expectation: data.expectations.get(cellId),
    factsLine: data.draftLines.get(cellId),
  }))
}

const ACTIVE = { speaker: "active", question: "active", negation: "active", you_number: "active" } as const

describe("judgeExpectations — code first", () => {
  it("makes no Jev call when code decides every question", async () => {
    const profile: LanguageProfile = { ...ENGLISH_QUOTES, negators: ["no", "not"] }
    const cells = await cellsFor({ c9: CORRECT_4_9 }, profile)
    const jev = scriptedJev(() => 0.9)
    const result = await judgeExpectations(cells, { profile, packVersion: "1.0.0", decide: jev.decide, cache: new Map() }, "s1")
    expect(jev.calls).toHaveLength(0)
    expect(result.jevCalls).toBe(0)
    expect(result.judgments).toEqual([{ cellId: "c9", check: "negation", outcome: "pass", decidedBy: "code", mode: "shadow" }])
  })

  it("asks nothing the pack says does not apply (4:8 has no speech, no question, no negation)", async () => {
    const cells = await cellsFor({ c8: "For his disciples had gone into the city." })
    const jev = scriptedJev(() => 0.9)
    const result = await judgeExpectations(cells, { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: jev.decide, cache: new Map() }, "s1")
    expect(result).toEqual({ judgments: [], jevCalls: 0 })
  })
})

describe("judgeExpectations — Jev", () => {
  it("batches every undecided question of the span into ONE call, keyed c{i}_{check}", async () => {
    const profile: LanguageProfile = { quoteMarks: ENGLISH_QUOTES.quoteMarks, speechVerbs: ["said"], pronouns: { secondPerson: { numberDistinction: true } } }
    // c7: Jesus speaks but the draft never names him by a speech verb; c9: negation, question (M1 dormant), "you".
    const cells = await cellsFor({ c7: "“Give me a drink.”", c9: "“How is it that you ask me for a drink”" }, profile)
    const jev = scriptedJev(() => 0.95)
    const result = await judgeExpectations(cells, { profile, packVersion: "1.0.0", decide: jev.decide, cache: new Map() }, "s1")
    expect(jev.calls).toHaveLength(1)
    expect(result.jevCalls).toBe(1)
    expect(Object.keys(jev.calls[0].questions).sort()).toEqual(
      ["c0_speaker", "c0_you_number", "c1_negation", "c1_question", "c1_speaker", "c1_you_number"].sort(),
    )
    expect(jev.calls[0].questions.c0_speaker.instructions).toMatchObject({
      question: "In this translation, are the quoted words spoken by Jesus?",
    })
  })

  it("abstains below certainty 0.4", async () => {
    const cells = await cellsFor({ c9: NEGATION_DROPPED_4_9 })
    // p = 0.35: certainty 0.3 — not enough to call it a "no".
    const jev = scriptedJev(() => 0.35)
    const result = await judgeExpectations(cells, { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: jev.decide, cache: new Map(), modes: ACTIVE }, "s1")
    expect(result.judgments).toEqual([
      expect.objectContaining({ check: "negation", outcome: "abstain", decidedBy: "jev", p: 0.35 }),
    ])
    expect(activeFailures(result)).toEqual([])
  })

  it("abstains on every question when Jev is off, capped or down", async () => {
    const cells = await cellsFor({ c9: NEGATION_DROPPED_4_9 })
    const down: BibleQaDecide = async (input) => ({ answers: input.fallback(), decidedBy: "heuristic", reason: "capped", model: null, usage: null })
    const result = await judgeExpectations(cells, { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: down, cache: new Map(), modes: ACTIVE }, "s1")
    expect(result.judgments.map((j) => [j.outcome, j.decidedBy])).toEqual([["abstain", "fallback"]])
  })

  it("SHADOW: a confident 'no' is recorded with its certainty and acts on nothing", async () => {
    expect(Object.values(BIBLE_QA_MODES).every((mode) => mode === "shadow")).toBe(true)
    const cells = await cellsFor({ c9: NEGATION_DROPPED_4_9 })
    const traces: BibleQaTrace[] = []
    const jev = scriptedJev(() => 0.05)
    const result = await judgeExpectations(
      cells,
      { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: jev.decide, cache: new Map(), record: (t) => traces.push(t) },
      "s1",
    )
    expect(result.judgments).toEqual([expect.objectContaining({ check: "negation", outcome: "fail", mode: "shadow", certainty: 0.9 })])
    expect(activeFailures(result)).toEqual([])
    expect(traces[0].judgments[0]).toMatchObject({ outcome: "fail", mode: "shadow" })
  })

  it("ACTIVE: the same 'no' is a failure with a templated constraint", async () => {
    const cells = await cellsFor({ c9: NEGATION_DROPPED_4_9 })
    const jev = scriptedJev(() => 0.05)
    const result = await judgeExpectations(cells, { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: jev.decide, cache: new Map(), modes: ACTIVE }, "s1")
    const [failure] = activeFailures(result)
    expect(failure).toMatchObject({ cellId: "c9", check: "negation" })
    expect(judgmentConstraint(failure, cells[0].facts)).toBe('Keep the negation: the source says "not".')
  })

  it("asks again only for new text: answers are cached per run by (content, check, pack version)", async () => {
    const cache = new Map<string, number>()
    const jev = scriptedJev(() => 0.9)
    const deps = { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: jev.decide, cache }
    await judgeExpectations(await cellsFor({ c9: NEGATION_DROPPED_4_9 }), deps, "s1")
    const again = await judgeExpectations(await cellsFor({ c9: NEGATION_DROPPED_4_9 }), deps, "s1")
    expect(jev.calls).toHaveLength(1)
    expect(again.judgments[0]).toMatchObject({ decidedBy: "cache", outcome: "pass" })
    await judgeExpectations(await cellsFor({ c9: CORRECT_4_9 }), deps, "s1")
    expect(jev.calls).toHaveLength(2)
    await judgeExpectations(await cellsFor({ c9: NEGATION_DROPPED_4_9 }), { ...deps, packVersion: "1.1.0" }, "s1")
    expect(jev.calls).toHaveLength(3)
  })

  it("never throws: a decide() that throws is an abstention", async () => {
    const cells = await cellsFor({ c9: NEGATION_DROPPED_4_9 })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await judgeExpectations(
      cells,
      { profile: ENGLISH_QUOTES, packVersion: "1.0.0", decide: async () => { throw new Error("boom") }, cache: new Map() },
      "s1",
    )
    expect(result.judgments[0]).toMatchObject({ outcome: "abstain", decidedBy: "fallback" })
    warn.mockRestore()
  })
})

describe("judgmentConstraint", () => {
  it("names the speaker and the addressee from the facts", async () => {
    const [c7] = await cellsFor({ c7: "x" })
    expect(judgmentConstraint({ check: "speaker" }, c7.facts)).toBe("Make clear that Jesus speaks these words.")
    expect(judgmentConstraint({ check: "you_number" }, c7.facts)).toBe('Use singular "you": Samaritan woman is one person.')
  })
})
