import { describe, expect, it } from "vitest"
import { construeScene, expandWindow, initialWindow, type ClosureContext } from "./closure"
import { construalJson, pair, scriptedLlm } from "./test-helpers"
import { createRunBudget, TIER_WEIGHTS, type SpanSeed } from "./types"

const seed: SpanSeed = {
  id: "span1",
  fileId: "f1",
  anchorCellId: "c3",
  startCellId: "c3",
  endCellId: "c5",
  seedSource: "chunk",
}

function makeContext(over: Partial<ClosureContext> = {}): ClosureContext {
  return {
    orderedPairs: Array.from({ length: 10 }, (_, i) => pair(`c${i + 1}`)),
    neighborBriefs: [],
    layerAbove: [],
    ...over,
  }
}

describe("construeScene — the three exits", () => {
  it("genuine-ambiguity exit: model closes with open questions → success + register", async () => {
    const { llm, calls } = scriptedLlm([
      construalJson({ closed: true, openQuestions: ["is 'he' the teacher or the crowd's leader?"] }),
    ])
    const budget = createRunBudget()
    const result = await construeScene({ seed, llm, budget, context: makeContext() })

    expect(result.closed).toBe(true)
    expect(result.incomplete).toBe(false)
    expect(result.exit).toBe("model-closed")
    expect(result.register).toEqual([
      { id: "span1:amb:1", question: "is 'he' the teacher or the crowd's leader?" },
    ])
    expect(result.rounds).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].tier).toBe("mid")
    expect(budget.unitsUsed).toBe(TIER_WEIGHTS.mid)
  })

  it("fixpoint exit: an expansion that changes nothing in the construal closes the loop", async () => {
    const same = construalJson({ closed: false, openQuestions: ["who sent them?"] })
    const { llm, calls } = scriptedLlm([same, same])
    const result = await construeScene({ seed, llm, budget: createRunBudget(), context: makeContext() })

    expect(result.closed).toBe(true)
    expect(result.incomplete).toBe(false)
    expect(result.exit).toBe("fixpoint")
    // Open questions that survived the fixpoint are genuine ambiguity.
    expect(result.register.map((a) => a.question)).toEqual(["who sent them?"])
    expect(result.rounds).toBe(2)
    // Round 2 saw a wider window than round 1 (the expansion happened).
    expect(calls[1].user.length).toBeGreaterThan(calls[0].user.length)
  })

  it("budget exit: unit exhaustion marks the span incomplete — never silently closed", async () => {
    let n = 0
    const { llm } = scriptedLlm(
      Array.from({ length: 10 }, () => () =>
        construalJson({ closed: false, situation: `changing construal ${++n}`, openQuestions: ["q?"] }),
      ),
    )
    // 2 mid rounds fit in 12 units; the 3rd (15) does not.
    const budget = createRunBudget({ maxUnits: 12 })
    const result = await construeScene({ seed, llm, budget, context: makeContext() })

    expect(result.closed).toBe(false)
    expect(result.incomplete).toBe(true)
    expect(result.exit).toBe("budget")
    // The two-exits rule: exhaustion is NOT genuine ambiguity.
    expect(result.register).toEqual([])
    expect(result.rounds).toBe(2)
    expect(budget.unitsUsed).toBe(10)
  })

  it("max-iterations exit: a never-converging construal stops at 6 rounds, incomplete", async () => {
    let n = 0
    const { llm, calls } = scriptedLlm(
      Array.from({ length: 10 }, () => () =>
        construalJson({ closed: false, situation: `shifting ${++n}`, openQuestions: ["q?"] }),
      ),
    )
    // Wide file so window growth never exhausts before the iteration cap.
    const context = makeContext({
      orderedPairs: Array.from({ length: 60 }, (_, i) => pair(`c${i + 1}`)),
      layerAbove: [{ ref: "project-brief", text: "a project" }],
    })
    const result = await construeScene({ seed, llm, budget: createRunBudget(), context })

    expect(result.exit).toBe("max-iterations")
    expect(result.incomplete).toBe(true)
    expect(result.rounds).toBe(6)
    expect(calls).toHaveLength(6)
  })

  it("window-exhausted exit: when nothing is left to read, open questions close as genuine", async () => {
    let n = 0
    const { llm } = scriptedLlm(
      Array.from({ length: 10 }, () => () =>
        construalJson({ closed: false, situation: `v${++n}`, openQuestions: ["untellable?"] }),
      ),
    )
    // Window == whole file, no briefs, no layer above → first expansion is a no-op.
    const wholeFile: SpanSeed = { ...seed, startCellId: "c1", endCellId: "c3" }
    const context = makeContext({ orderedPairs: [pair("c1"), pair("c2"), pair("c3")] })
    const result = await construeScene({ seed: wholeFile, llm, budget: createRunBudget(), context })

    expect(result.exit).toBe("window-exhausted")
    expect(result.closed).toBe(true)
    expect(result.register.map((a) => a.question)).toEqual(["untellable?"])
  })

  it("tolerates unparseable rounds without crashing (they consume iterations)", async () => {
    const { llm } = scriptedLlm([
      "sorry, I cannot answer in JSON",
      construalJson({ closed: true, openQuestions: [] }),
    ])
    const result = await construeScene({ seed, llm, budget: createRunBudget(), context: makeContext() })
    expect(result.closed).toBe(true)
    expect(result.rounds).toBe(2)
    expect(result.register).toEqual([])
  })
})

describe("expandWindow — growth policy", () => {
  const construal = JSON.parse(construalJson()) as never

  it("consumes adjacent approved briefs before raw cells", () => {
    const context = makeContext({
      neighborBriefs: [
        { id: "sb-prev", l1Summary: "the previous scene", side: "before" },
        { id: "sb-next", l1Summary: "the next scene", side: "after" },
      ],
    })
    const w0 = initialWindow(seed, context)
    const w1 = expandWindow(w0, construal, context)
    expect(w1.precedingBriefIds).toEqual(["sb-prev"])
    expect(w1.cellIds).toEqual(w0.cellIds)
    const w2 = expandWindow(w1, construal, context)
    expect(w2.precedingBriefIds).toEqual(["sb-prev", "sb-next"])
  })

  it("then grows raw cells (forward, and backward when no brief covers that side)", () => {
    const context = makeContext()
    const w0 = initialWindow(seed, context) // c3..c5 of c1..c10
    const w1 = expandWindow(w0, construal, context)
    expect(w1.cellIds).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8", "c9"])
  })

  it("then adds the layer above, and finally returns the window unchanged", () => {
    const context = makeContext({
      orderedPairs: [pair("c3"), pair("c4"), pair("c5")],
      layerAbove: [{ ref: "file-intro", text: "an introduction" }],
    })
    const w0 = initialWindow(seed, context)
    const w1 = expandWindow(w0, construal, context)
    expect(w1.layerAboveRefs).toEqual(["file-intro"])
    const w2 = expandWindow(w1, construal, context)
    expect(w2).toEqual(w1) // exhausted
  })
})
