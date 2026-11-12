import { describe, expect, it } from "vitest"
import {
  buildCleanupMessages,
  CLEANUP_MAX_PAIRS,
  countChangedWords,
  parseCleanupResult,
  type CleanupInput,
} from "./prompt"

const base: CleanupInput = {
  heard: "ni eema akaenda kwa mji kapernaumu",
  language: "Swahili",
  pairs: [{ heard: "eema akasema", corrected: "Yesu akasema" }],
  correctedOnly: [],
  terms: [{ term: "Yesu", note: "Jesus" }],
  context: [],
}

describe("buildCleanupMessages", () => {
  it("teaches from the team's own corrections and key terms, and marks them as data", () => {
    const [system, user] = buildCleanupMessages(base)
    expect(system.content).toMatch(/untrusted data/)
    expect(user.content).toContain("heard: eema akasema\ncorrected: Yesu akasema")
    expect(user.content).toContain("Yesu — Jesus")
    expect(user.content).toContain("<transcript>\nni eema akaenda kwa mji kapernaumu\n</transcript>")
  })

  it("tells the model never to add unspoken words — a cleanup must not invent speech", () => {
    const [system] = buildCleanupMessages(base)
    expect(system.content).toMatch(/Never add words/)
  })

  it("fills only the example budget the pairs leave with corrected-only transcripts", () => {
    const pairs = Array.from({ length: CLEANUP_MAX_PAIRS - 1 }, (_, i) => ({ heard: `h${i}`, corrected: `c${i}` }))
    const [, user] = buildCleanupMessages({ ...base, pairs, correctedOnly: ["only-a", "only-b"] })
    expect(user.content).toContain("only-a")
    expect(user.content).not.toContain("only-b")
  })

  it("omits empty sections so the model is not shown a blank example block", () => {
    const [, user] = buildCleanupMessages({ ...base, pairs: [], terms: [] })
    expect(user.content).not.toContain("<team-corrections>")
    expect(user.content).not.toContain("<key-terms>")
  })
})

describe("parseCleanupResult", () => {
  it("accepts a cleanup and counts its changes", () => {
    const r = parseCleanupResult(
      JSON.stringify({ text: "ni Yesu akaenda mjini kapernaumu", notes: [{ heard: "eema", wrote: "Yesu", reason: "name" }] }),
      base.heard,
    )
    expect(r.kind).toBe("ok")
    if (r.kind !== "ok") return
    expect(r.text).toBe("ni Yesu akaenda mjini kapernaumu")
    expect(r.notes).toHaveLength(1)
    expect(r.changes).toBe(3)
  })

  it("reports an unchanged transcript (case and punctuation aside) as unchanged, so nothing is marked AI", () => {
    expect(parseCleanupResult(JSON.stringify({ text: "Ni eema, akaenda kwa mji Kapernaumu." }), base.heard).kind).toBe("unchanged")
  })

  it("refuses a result that adds or drops too many words — the model filled in speech", () => {
    const longer = `${base.heard} na wanafunzi wake wote pamoja nao`
    expect(parseCleanupResult(JSON.stringify({ text: longer }), base.heard).kind).toBe("too-different")
  })

  it("allows a one-word join or split on a short take", () => {
    expect(parseCleanupResult(JSON.stringify({ text: "kwa mji" }), "kwamji").kind).toBe("ok")
  })

  it("treats non-JSON or an empty text as invalid", () => {
    expect(parseCleanupResult("sorry, I cannot", base.heard).kind).toBe("invalid")
    expect(parseCleanupResult(JSON.stringify({ text: "  " }), base.heard).kind).toBe("invalid")
  })

  it("reads JSON wrapped in prose or a code fence", () => {
    expect(parseCleanupResult('```json\n{"text":"ni Yesu akaenda kwa mji kapernaumu"}\n```', base.heard).kind).toBe("ok")
  })
})

describe("countChangedWords", () => {
  it("counts a replaced middle span by its longer side", () => {
    expect(countChangedWords("a b c d", "a x y z d")).toBe(3)
    expect(countChangedWords("a b c", "a b c")).toBe(0)
  })
})
