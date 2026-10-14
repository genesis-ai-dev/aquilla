// AQU-1701: C1 — Translation Questions as an automated comprehension check.
//
// WHY: a Translation Question is what a community checker asks a reader of a
// draft. Asked of a range that is only half translated, its answer may sit in
// the half not yet written, and a "no" would blame the translation for a gap:
// the range must be whole. One call per chapter keeps a whole book at about a
// call a chapter. Jev's accuracy here is unmeasured, so answers stay in SHADOW
// — recorded, acted on by nothing — until the shadow eval says otherwise; and
// even active, a "no" is a finding for a person, never a constraint to redraft
// against.

import { describe, expect, it, vi } from "vitest"
import type { DecideResult, JevAnswer } from "../jev/decide"
import type { BkpQuestion } from "../bkp/pack-types"
import { JHN4_QUESTIONS } from "./bible-test-helpers"
import { judgeComprehension, MAX_TQ_PER_CALL, refsLabel, type ComprehensionCell, type ComprehensionInput } from "./judge-comprehension"
import { BIBLE_QA_MODES, type BibleQaDecide } from "./judge-expectations"

const TEXT: Record<string, string> = {
  c7: "A woman of Samaria came to draw water. Jesus said to her, “Give me a drink.”",
  c8: "For his disciples had gone away into the city to buy food.",
  c9: "The Samaritan woman said to him, “How is it that you, a Jew, ask for a drink from me?” (For Jews have no dealings with Samaritans.)",
  c10: "Jesus answered her, “If you knew the gift of God, you would have asked him, and he would have given you living water.”",
  c5_1: "After these things, there was a feast of the Jews, and Jesus went up to Jerusalem.",
}
const REFS: Record<string, string> = { c7: "JHN 4:7", c8: "JHN 4:8", c9: "JHN 4:9", c10: "JHN 4:10", c5_1: "JHN 5:1" }
/** A Translation Question shaped like the pack's, over two verses. */
const ACROSS_9_10: BkpQuestion = { id: "tq:test-9-10", refs: ["JHN 4:9", "JHN 4:10"], q: "What did Jesus offer?", a: "Jesus offered her living water." }
const TQ_5_1: BkpQuestion = { id: "tq:172810", refs: ["JHN 5:1"], q: "Where did Jesus go?", a: "Jesus went up to Jerusalem." }

function cells(ids: readonly string[], blank: readonly string[] = []): ComprehensionCell[] {
  return ids.map((id) => ({ cellId: id, refs: [REFS[id]], text: blank.includes(id) ? "" : TEXT[id] }))
}

/** A scripted Jev: answers each key with p, and records every call. */
function scriptedJev(p: (key: string) => number, decidedBy: DecideResult["decidedBy"] = "model") {
  const calls: Parameters<BibleQaDecide>[0][] = []
  const decide: BibleQaDecide = async (input) => {
    calls.push(input)
    if (decidedBy === "heuristic") return { answers: input.fallback(), decidedBy, reason: "capped", model: null, usage: null }
    const answers: Record<string, JevAnswer> = {}
    for (const key of Object.keys(input.questions)) answers[key] = { kind: "noul", p: p(key) }
    return { answers, decidedBy, model: "typesafe/jev-1.13", usage: { input_tokens: 9, output_tokens: 2 } }
  }
  return { decide, calls }
}

function input(over: Partial<ComprehensionInput> = {}): ComprehensionInput {
  const all = ["c7", "c8", "c9", "c10"]
  return {
    questions: JHN4_QUESTIONS,
    cells: cells(all),
    checked: new Set(all),
    owner: "touches",
    traceSpanId: "span-1",
    ...over,
  }
}

describe("C1 — which Translation Questions are asked", () => {
  it("asks one question per TQ whose whole range has text, in ONE call per chapter", async () => {
    const jev = scriptedJev(() => 0.95)
    const result = await judgeComprehension(
      input({ questions: [...JHN4_QUESTIONS, TQ_5_1], cells: cells(["c7", "c8", "c9", "c10", "c5_1"]), checked: new Set(["c7", "c8", "c9", "c10", "c5_1"]) }),
      { packVersion: "1.2.0", decide: jev.decide, cache: new Map() },
    )
    expect(jev.calls).toHaveLength(2)
    expect(result.jevCalls).toBe(2)
    expect(jev.calls.map((c) => [c.state.chapter, Object.keys(c.questions).length])).toEqual([["JHN 4", 5], ["JHN 5", 1]])
    // Two TQs ask about JHN 4:7: its text is sent once.
    expect((jev.calls[0].state.passages as unknown[]).length).toBe(4)
    expect(jev.calls[0].questions.q0.instructions).toEqual({
      passage: "passage 0",
      question: "Given this translation of JHN 4:7 (passage 0): does the translation say that A Samaritan woman came there to draw water?",
    })
    expect(result.judgments.map((j) => j.tq)).toEqual([...JHN4_QUESTIONS.map((q) => q.id), TQ_5_1.id])
  })

  it("skips a TQ whose range has a verse with no text yet; a single verse with text is still asked", async () => {
    const jev = scriptedJev(() => 0.95)
    const result = await judgeComprehension(
      input({ questions: [ACROSS_9_10, JHN4_QUESTIONS[3]], cells: cells(["c9", "c10"], ["c10"]), checked: new Set(["c9"]) }),
      { packVersion: "1.2.0", decide: jev.decide, cache: new Map() },
    )
    expect(result.judgments.map((j) => j.tq)).toEqual(["tq:172802"])
    expect(Object.keys(jev.calls[0].questions)).toEqual(["q0"])
  })

  it("autopilot ('touches') asks only the TQs whose range touches a draft", async () => {
    const jev = scriptedJev(() => 0.95)
    const result = await judgeComprehension(input({ checked: new Set(["c10"]) }), { packVersion: "1.2.0", decide: jev.decide, cache: new Map() })
    expect(result.judgments.map((j) => j.tq)).toEqual(["tq:172803"])
  })

  it("check mode ('first-verse') asks a TQ across two calls once: in the call that checks its first verse", async () => {
    const deps = { packVersion: "1.2.0", decide: scriptedJev(() => 0.95).decide, cache: new Map<string, number>() }
    const all = { questions: [ACROSS_9_10], cells: cells(["c9", "c10"]), owner: "first-verse" as const }
    const first = await judgeComprehension(input({ ...all, checked: new Set(["c9"]) }), deps)
    const second = await judgeComprehension(input({ ...all, checked: new Set(["c10"]) }), deps)
    expect(first.judgments.map((j) => j.tq)).toEqual(["tq:test-9-10"])
    expect(second.judgments).toEqual([])
  })

  it(`never puts more than ${MAX_TQ_PER_CALL} questions in one call`, async () => {
    const many = Array.from({ length: MAX_TQ_PER_CALL + 1 }, (_, i) => ({ id: `tq:${i}`, refs: ["JHN 4:7"], q: `Q${i}?`, a: `Answer ${i}.` }))
    const jev = scriptedJev(() => 0.95)
    await judgeComprehension(input({ questions: many }), { packVersion: "1.2.0", decide: jev.decide, cache: new Map() })
    expect(jev.calls.map((c) => Object.keys(c.questions).length)).toEqual([MAX_TQ_PER_CALL, 1])
  })

  it("asks again only for new text: answers are cached by (passage, TQ, pack version)", async () => {
    const jev = scriptedJev(() => 0.95)
    const deps = { packVersion: "1.2.0", decide: jev.decide, cache: new Map<string, number>() }
    await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), deps)
    const again = await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), deps)
    expect(jev.calls).toHaveLength(1)
    expect(again.judgments[0]).toMatchObject({ decidedBy: "cache", outcome: "pass" })
    await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]], cells: [{ cellId: "c8", refs: ["JHN 4:8"], text: "His disciples stayed." }] }), deps)
    expect(jev.calls).toHaveLength(2)
  })
})

describe("C1 — what an answer does", () => {
  it("SHADOW by default: a confident 'no' is recorded and makes no finding", async () => {
    expect(BIBLE_QA_MODES.tq).toBe("shadow")
    const traces: unknown[] = []
    const result = await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), {
      packVersion: "1.2.0",
      decide: scriptedJev(() => 0.05).decide,
      cache: new Map(),
      record: (t) => traces.push(t),
    })
    expect(result.judgments).toEqual([
      expect.objectContaining({ cellId: "c8", check: "tq", tq: "tq:172801", outcome: "fail", mode: "shadow", certainty: 0.9 }),
    ])
    expect(result.findings).toEqual([])
    expect(traces).toHaveLength(1)
  })

  it("ACTIVE: a confident 'no' is a bkp:C1 finding on the first drafted cell of the range, with the question and its answer", async () => {
    const result = await judgeComprehension(input({ questions: [ACROSS_9_10, ...JHN4_QUESTIONS.slice(0, 2)], checked: new Set(["c7", "c10"]) }), {
      packVersion: "1.2.0",
      decide: scriptedJev(() => 0.05).decide,
      cache: new Map(),
      mode: "active",
    })
    expect(result.findings).toEqual([
      {
        cellId: "c10",
        code: "bkp:C1",
        params: {
          kind: "answer-missing",
          evidence: "translation-question",
          tq: "tq:test-9-10",
          refs: "JHN 4:9,JHN 4:10",
          question: "What did Jesus offer?",
          answer: "Jesus offered her living water.",
        },
      },
      // Two TQs failed on JHN 4:7: one finding, with the first as evidence and a count of the rest.
      expect.objectContaining({ cellId: "c7", params: expect.objectContaining({ tq: "tq:172799", more: "1" }) }),
    ])
  })

  it("abstains below certainty 0.4, and on every question when Jev is off, capped or down — even when active", async () => {
    const unsure = await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), {
      packVersion: "1.2.0",
      decide: scriptedJev(() => 0.35).decide,
      cache: new Map(),
      mode: "active",
    })
    expect(unsure.judgments[0]).toMatchObject({ outcome: "abstain", decidedBy: "jev", p: 0.35 })
    expect(unsure.findings).toEqual([])
    const capped = await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), {
      packVersion: "1.2.0",
      decide: scriptedJev(() => 0.05, "heuristic").decide,
      cache: new Map(),
      mode: "active",
    })
    expect(capped.judgments[0]).toMatchObject({ outcome: "abstain", decidedBy: "fallback" })
    expect(capped.findings).toEqual([])
  })

  it("never throws: a decide() that throws is an abstention", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const result = await judgeComprehension(input({ questions: [JHN4_QUESTIONS[2]] }), {
      packVersion: "1.2.0",
      decide: async () => {
        throw new Error("boom")
      },
      cache: new Map(),
      mode: "active",
    })
    expect(result.judgments[0]).toMatchObject({ outcome: "abstain", decidedBy: "fallback" })
    warn.mockRestore()
  })
})

describe("refsLabel", () => {
  it("writes a range in one chapter as JHN 4:9–10", () => {
    expect(refsLabel(["JHN 4:9"])).toBe("JHN 4:9")
    expect(refsLabel(["JHN 4:9", "JHN 4:10"])).toBe("JHN 4:9–10")
    expect(refsLabel(["JHN 4:54", "JHN 5:1"])).toBe("JHN 4:54, JHN 5:1")
  })
})
