import { describe, expect, it } from "vitest"
import {
  analyzeSupport,
  buildAttestation,
  confirmSupport,
  parseConfirmReply,
  tokenizeSupport,
  toSupportSignal,
  CELL_SUPPORT_FLOOR,
  MIN_CORPUS_TEXTS,
  MIN_CORPUS_TOKENS,
  type SupportCorpus,
} from "./support"
import { scriptedLlm } from "./test-helpers"
import { createRunBudget, type SpanDraft } from "./types"

/** A corpus large enough to clear both applicability floors. */
function richCorpus(extraTargets: string[] = []): SupportCorpus {
  const vocab = [
    "the teacher went up the mountain and sat down with his followers",
    "he opened his mouth and began to teach them saying",
    "blessed are those who mourn for they shall be comforted",
    "blessed are the gentle for they shall inherit the earth",
    "you are the salt of the earth but if salt loses its taste",
    "a city built on a hill cannot be hidden from anyone",
    "let your light shine before others so they may see your good works",
    "do not think that I came to abolish the law or the prophets",
  ]
  return { targets: [...vocab, ...extraTargets], sources: ["source one", "source two"] }
}

function draftOf(cells: { cellId: string; text: string }[]): SpanDraft {
  return { spanId: "span1", sceneBriefId: "sb1", cells, exampleIds: [], promptVersion: "v" }
}

describe("tokenizeSupport", () => {
  it("folds case, strips markup and punctuation, keeps letters/marks/numbers", () => {
    expect(tokenizeSupport("<em>Hello,</em> World! 42")).toEqual(["hello", "world", "42"])
  })

  it("keeps combining marks attached rather than shattering the word", () => {
    // Hebrew consonant + niqqud must stay one token.
    expect(tokenizeSupport("בָּרָא")).toEqual(["בָּרָא"])
  })

  it("returns nothing for empty or markup-only text", () => {
    expect(tokenizeSupport("")).toEqual([])
    expect(tokenizeSupport("<br/>")).toEqual([])
  })
})

describe("buildAttestation", () => {
  it("counts distinct TARGET tokens only — source vocabulary is a different language", () => {
    const att = buildAttestation({ targets: ["alpha beta"], sources: ["gamma delta epsilon"] })
    expect(att.distinctTargets).toBe(2)
    expect(att.exact.has("gamma")).toBe(true) // still attests
  })
})

describe("analyzeSupport — abstention", () => {
  it("abstains below the corpus-text floor", () => {
    const support = analyzeSupport(draftOf([{ cellId: "c1", text: "anything at all here" }]), {
      targets: Array.from({ length: MIN_CORPUS_TEXTS - 1 }, (_, i) => `text ${i}`),
      sources: [],
    })
    expect(support.applicable).toBe(false)
    expect(support.abstainReason).toContain(`${MIN_CORPUS_TEXTS}`)
    expect(support.suspect).toEqual([])
  })

  it("abstains when the corpus vocabulary is too small to make 'novel' mean anything", () => {
    const support = analyzeSupport(draftOf([{ cellId: "c1", text: "brand new invented wording" }]), {
      targets: ["example target one", "example target two", "example target three", "example target four", "example target five"],
      sources: [],
    })
    expect(support.applicable).toBe(false)
    expect(support.abstainReason).toContain(`< ${MIN_CORPUS_TOKENS}`)
  })
})

describe("analyzeSupport — attestation", () => {
  it("a draft built only from corpus wording is fully supported", () => {
    const support = analyzeSupport(
      draftOf([{ cellId: "c1", text: "Blessed are the gentle, for they shall inherit the earth." }]),
      richCorpus(),
    )
    expect(support.applicable).toBe(true)
    expect(support.ratio).toBe(1)
    expect(support.suspect).toEqual([])
    expect(support.cells[0].novel).toEqual([])
  })

  it("flags a cell whose wording the retrieval never showed", () => {
    const support = analyzeSupport(
      draftOf([{ cellId: "c1", text: "Quarterly amortization schedules reconcile depreciation." }]),
      richCorpus(),
    )
    expect(support.applicable).toBe(true)
    expect(support.suspect.map((c) => c.cellId)).toEqual(["c1"])
    expect(support.cells[0].ratio).toBeLessThan(CELL_SUPPORT_FLOOR)
    expect(support.cells[0].novel).toContain("amortization")
  })

  it("prefix matching absorbs inflection instead of calling it invention", () => {
    // "comforted" is attested; "comforting"/"comforters" share its 5-char stem.
    const support = analyzeSupport(
      draftOf([{ cellId: "c1", text: "comforting comforters mourned mourning" }]),
      richCorpus(),
    )
    expect(support.cells[0].novel).toEqual([])
    expect(support.suspect).toEqual([])
  })

  it("does not judge cells shorter than the minimum length", () => {
    const support = analyzeSupport(draftOf([{ cellId: "c1", text: "zzz qqq" }]), richCorpus())
    expect(support.cells[0].ratio).toBe(0)
    expect(support.suspect).toEqual([]) // measured, never routed on
  })

  it("dedupes novel tokens and caps how many it reports", () => {
    const text = Array.from({ length: 40 }, (_, i) => `neologismum${i}`).join(" ")
    const support = analyzeSupport(draftOf([{ cellId: "c1", text }]), richCorpus())
    // All share the 5-char prefix "neolo", so none is attested, but the cap holds.
    expect(support.cells[0].novel.length).toBeLessThanOrEqual(12)
    expect(new Set(support.cells[0].novel).size).toBe(support.cells[0].novel.length)
  })

  it("span ratio aggregates only judged cells", () => {
    const support = analyzeSupport(
      draftOf([
        { cellId: "c1", text: "blessed are those who mourn for they shall be comforted" },
        { cellId: "c2", text: "zz" }, // too short to judge
      ]),
      richCorpus(),
    )
    expect(support.ratio).toBe(1)
  })
})

describe("parseConfirmReply", () => {
  const suspect = [
    { cellId: "c1", tokens: 8, attested: 3, ratio: 0.375, novel: ["x"] },
    { cellId: "c2", tokens: 8, attested: 2, ratio: 0.25, novel: ["y"] },
  ]

  it("maps 1-based indexes back to cell ids", () => {
    const parsed = parseConfirmReply('{"cells":[{"i":1,"risky":false},{"i":2,"risky":true,"reason":"invented"}]}', suspect)
    expect(parsed).toEqual([
      { cellId: "c1", risky: false, reason: "" },
      { cellId: "c2", risky: true, reason: "invented" },
    ])
  })

  it("tolerates prose around the object and drops malformed entries", () => {
    const parsed = parseConfirmReply('sure!\n{"cells":[{"i":1,"risky":true},{"i":99,"risky":true},{"risky":true}]}\ndone', suspect)
    expect(parsed).toEqual([{ cellId: "c1", risky: true, reason: "" }])
  })

  it("returns null when there is no object or no cells array", () => {
    expect(parseConfirmReply("no json here", suspect)).toBeNull()
    expect(parseConfirmReply('{"ok":true}', suspect)).toBeNull()
  })
})

describe("confirmSupport", () => {
  const draft = draftOf([
    { cellId: "c1", text: "Quarterly amortization schedules reconcile depreciation." },
    { cellId: "c2", text: "Blessed are the gentle for they shall inherit the earth." },
  ])
  const sourcesByCellId = new Map([
    ["c1", "makarioi hoi praeis"],
    ["c2", "makarioi hoi praeis"],
  ])

  it("costs nothing when code flagged nothing", async () => {
    const { llm, calls } = scriptedLlm([])
    const budget = createRunBudget()
    const support = analyzeSupport(draftOf([{ cellId: "c2", text: "blessed are the gentle for they shall inherit the earth" }]), richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, llm, budget })
    expect(calls).toHaveLength(0)
    expect(budget.callsUsed).toBe(0)
    expect(result).toEqual({ riskyCellIds: [], reasons: {}, confirmed: true })
  })

  it("runs on the FAST tier and clears benign morphology", async () => {
    const { llm, calls } = scriptedLlm(['{"cells":[{"i":1,"risky":false,"reason":"ordinary inflection"}]}'])
    const budget = createRunBudget()
    const support = analyzeSupport(draft, richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, targetLanguage: "Swahili", llm, budget })
    expect(calls[0].tier).toBe("fast")
    expect(calls[0].label).toBe("support")
    expect(calls[0].system).toContain("Swahili")
    expect(calls[0].user).toContain("amortization")
    expect(budget.unitsUsed).toBe(1) // fast weight
    expect(result.confirmed).toBe(true)
    expect(result.riskyCellIds).toEqual([])
  })

  it("carries a confirmed-risky cell through with its reason", async () => {
    const { llm } = scriptedLlm(['{"cells":[{"i":1,"risky":true,"reason":"content absent from the source"}]}'])
    const support = analyzeSupport(draft, richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, llm, budget: createRunBudget() })
    expect(result.riskyCellIds).toEqual(["c1"])
    expect(result.reasons.c1).toBe("content absent from the source")
  })

  it("escalates every flagged cell when the confirmation call throws", async () => {
    const llm = async (): Promise<string> => {
      throw new Error("upstream down")
    }
    const support = analyzeSupport(draft, richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, llm, budget: createRunBudget() })
    expect(result.confirmed).toBe(false)
    expect(result.riskyCellIds).toEqual(["c1"])
  })

  it("escalates when the reply is unparseable", async () => {
    const { llm } = scriptedLlm(["I think it's fine, honestly"])
    const support = analyzeSupport(draft, richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, llm, budget: createRunBudget() })
    expect(result.confirmed).toBe(false)
    expect(result.error).toContain("parseable")
    expect(result.riskyCellIds).toEqual(["c1"])
  })

  it("escalates when the budget cannot afford even the fast call", async () => {
    const { llm, calls } = scriptedLlm([])
    const budget = createRunBudget({ maxCalls: 0 })
    const support = analyzeSupport(draft, richCorpus())
    const result = await confirmSupport({ draft, support, sourcesByCellId, llm, budget })
    expect(calls).toHaveLength(0)
    expect(result.confirmed).toBe(false)
    expect(result.riskyCellIds).toEqual(["c1"])
  })

  it("escalates a flagged cell the model silently omitted from an otherwise valid verdict", async () => {
    const twoSuspect = draftOf([
      { cellId: "c1", text: "Quarterly amortization schedules reconcile depreciation." },
      { cellId: "c3", text: "Subscribers may cancel their enterprise subscription anytime." },
    ])
    const support = analyzeSupport(twoSuspect, richCorpus())
    expect(support.suspect.map((c) => c.cellId)).toEqual(["c1", "c3"])
    // The model answered for item 1 only; item 2 was never triaged.
    const { llm } = scriptedLlm(['{"cells":[{"i":1,"risky":false,"reason":"fine"}]}'])
    const result = await confirmSupport({
      draft: twoSuspect,
      support,
      sourcesByCellId: new Map([["c1", "s1"], ["c3", "s3"]]),
      llm,
      budget: createRunBudget(),
    })
    expect(result.confirmed).toBe(true)
    expect(result.riskyCellIds).toEqual(["c3"])
    expect(result.reasons.c3).toContain("omitted")
  })
})

describe("toSupportSignal", () => {
  const mixed = draftOf([
    { cellId: "c1", text: "blessed are those who mourn for they shall be comforted" },
    { cellId: "c2", text: "quarterly amortization schedules reconcile depreciation entries" },
  ])

  it("keeps a confirmed-risky cell in the ratio", () => {
    const support = analyzeSupport(mixed, richCorpus())
    const signal = toSupportSignal(support, { riskyCellIds: ["c2"], reasons: {}, confirmed: true })
    expect(signal.applicable).toBe(true)
    expect(signal.riskyCellIds).toEqual(["c2"])
    expect(signal.ratio).toBeCloseTo(support.ratio, 10)
    expect(signal.ratio).toBeLessThan(1)
  })

  it("drops a CLEARED cell out of the ratio — tier 2 is not overruled by tier 1", () => {
    const support = analyzeSupport(mixed, richCorpus())
    expect(support.ratio).toBeLessThan(1) // c2 drags the raw measurement down
    const signal = toSupportSignal(support, { riskyCellIds: [], reasons: {}, confirmed: true })
    expect(signal.ratio).toBe(1)
    expect(signal.riskyCellIds).toEqual([])
  })

  it("reports a full ratio when every judged cell was cleared", () => {
    const support = analyzeSupport(draftOf([{ cellId: "c2", text: "quarterly amortization schedules reconcile" }]), richCorpus())
    const signal = toSupportSignal(support, { riskyCellIds: [], reasons: {}, confirmed: true })
    expect(signal.ratio).toBe(1)
  })
})
