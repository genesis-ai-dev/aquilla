// AQU-1701: the Jev shadow eval's arithmetic, against a fake decide() with
// known answers.
//
// WHY: the eval decides whether a question may act on people's drafts, so
// its numbers must be right: precision is right flags over all flags, recall
// is right flags over all planted errors (an abstention is a miss, as in
// production), and a "you" that should be plural passes on a "no". And it
// spends real money: --max-calls is a HARD cap, so a run never makes one call
// past it, and says which cases it never asked.

import { describe, expect, it } from "vitest"
import {
  batchCases,
  CallBudget,
  recommendMode,
  runUnits,
  scoreQuestion,
  type AskUnit,
  type EvalCase,
  type EvalUnit,
} from "./jev-shadow-eval"

interface FakeCase extends EvalCase {
  /** The answer the fake decide() gives this case. */
  p: number | null
}

const USAGE = { inputTokens: 10, outputTokens: 2, costUsd: null }

/** A fake decide(): each case's known answer, counting calls as a real one would. */
function fakeAsk(): { ask: AskUnit<FakeCase>; calls: () => number } {
  let calls = 0
  return {
    ask: async (unit) => {
      calls += unit.calls
      return { p: unit.cases.map((c) => c.p), usage: USAGE }
    },
    calls: () => calls,
  }
}

const c = (kind: FakeCase["kind"], p: number | null, ref: string, passWhenYes = true, question = "negation"): FakeCase => ({
  question,
  kind,
  passWhenYes,
  ref,
  p,
})

const units = (cases: FakeCase[], size = 1): EvalUnit<FakeCase>[] =>
  batchCases(cases, size).map((batch) => ({ question: batch[0].question, cases: batch, calls: 1 }))

describe("--max-calls is a hard cap", () => {
  it("never makes a call past the cap, stops cleanly, and reports the cases it never asked", async () => {
    const cases = Array.from({ length: 10 }, (_, i) => c("correct", 0.9, `JHN 1:${i + 1}`))
    const fake = fakeAsk()
    const result = await runUnits(units(cases), fake.ask, new CallBudget(3), 4)
    expect(fake.calls()).toBe(3)
    expect(result.capped).toBe(true)
    expect(result.answered).toHaveLength(3)
    expect(result.notAsked).toHaveLength(7)
    expect(scoreQuestion("negation", result)).toMatchObject({ calls: 3, notAsked: 7 })
  })

  it("does not start a unit whose calls no longer all fit (a C1 chapter of two calls with one left)", async () => {
    const chapter: EvalUnit<FakeCase> = { question: "tq", cases: [c("correct", 0.9, "JHN 4", true, "tq")], calls: 2 }
    const fake = fakeAsk()
    const budget = new CallBudget(3)
    const result = await runUnits([{ ...chapter }, { ...chapter }], fake.ask, budget)
    expect(fake.calls()).toBe(2)
    expect(budget.used).toBe(2)
    expect(result.notAsked).toHaveLength(1)
  })
})

describe("precision and recall per certainty band", () => {
  // Published text (a "yes" is right):
  //   0.9 pass · 0.3 flag (certainty 0.4) · 0.1 flag (0.8) · 0.45 abstains (0.1)
  // Planted errors (a "no" is right):
  //   0.05 flag (0.9) · 0.25 flag (0.5) · 0.35 abstains (0.3) · 0.95 missed · no answer
  const run = () =>
    runUnits(
      units([
        c("correct", 0.9, "r1"),
        c("correct", 0.3, "r2"),
        c("correct", 0.1, "r3"),
        c("correct", 0.45, "r4"),
        c("planted", 0.05, "r5"),
        c("planted", 0.25, "r6"),
        c("planted", 0.35, "r7"),
        c("planted", 0.95, "r8"),
        c("planted", null, "r9"),
      ]),
      fakeAsk().ask,
      new CallBudget(100),
    )

  it("counts right flags over all flags, and right flags over ALL planted errors", async () => {
    const score = scoreQuestion("negation", await run())
    expect(score).toMatchObject({ correct: 4, planted: 5, unanswered: 1 })
    expect(score.bands).toEqual([
      { band: 0.4, flaggedCorrect: 2, flaggedPlanted: 2, precision: 0.5, recall: 0.4 },
      { band: 0.6, flaggedCorrect: 1, flaggedPlanted: 1, precision: 0.5, recall: 0.2 },
      { band: 0.8, flaggedCorrect: 1, flaggedPlanted: 1, precision: 0.5, recall: 0.2 },
    ])
    // 0.45, 0.35 and the unanswered one: 3 of 9.
    expect(score.abstainRate).toBeCloseTo(3 / 9)
  })

  it("lets a 'you' that should be plural pass on a confident 'no' (passWhenYes false)", async () => {
    const plural = await runUnits(
      units([c("correct", 0.1, "r1", false, "you_number"), c("planted", 0.9, "r2", false, "you_number")]),
      fakeAsk().ask,
      new CallBudget(10),
    )
    expect(scoreQuestion("you_number", plural).bands[0]).toMatchObject({ flaggedCorrect: 0, flaggedPlanted: 1, precision: 1, recall: 1 })
  })
})

describe("batches", () => {
  it("never put a verse beside its own planted twin", () => {
    const cases = [c("correct", 0.9, "JHN 4:9"), c("planted", 0.1, "JHN 4:9"), c("correct", 0.9, "JHN 4:10")]
    expect(batchCases(cases, 12).map((batch) => batch.map((x) => `${x.kind} ${x.ref}`))).toEqual([
      ["correct JHN 4:9", "correct JHN 4:10"],
      ["planted JHN 4:9"],
    ])
  })
})

describe("recommended mode", () => {
  const score = (precision: number, recall: number, n = 50) => ({
    question: "negation",
    correct: n,
    planted: n,
    unanswered: 0,
    abstainRate: 0,
    bands: [0.4, 0.6, 0.8].map((band) => ({ band, flaggedCorrect: 0, flaggedPlanted: 0, precision, recall })),
    calls: 1,
    usage: USAGE,
    notAsked: 0,
  })

  it("is active only past the ship gate (precision ≥ 0.90, recall ≥ 0.80) on at least 30 cases a side", () => {
    expect(recommendMode(score(0.95, 0.85)).mode).toBe("active")
    expect(recommendMode(score(0.85, 0.95)).mode).toBe("shadow")
    expect(recommendMode(score(0.95, 0.7)).mode).toBe("shadow")
    expect(recommendMode(score(1, 1, 10))).toMatchObject({ mode: "shadow", why: expect.stringContaining("too few cases") })
  })
})
