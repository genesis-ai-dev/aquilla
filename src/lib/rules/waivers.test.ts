import { describe, it, expect } from "vitest"
import {
  isWaived,
  addWaiver,
  removeWaiver,
  partitionInfractions,
  waiverKey,
  waivedKeys,
  waivedMatchHashes,
  isSpanWaived,
  spanMatchHash,
  distinctFindings,
} from "./waivers"
import { matchHash } from "./match-hash"
import type { RuleWaiver, RuleInfraction, InfractionSpan } from "@/lib/parsers/types"

const waiver = (ruleId: string, extra: Partial<RuleWaiver> = {}): RuleWaiver => ({
  ruleId, waivedAt: "2026-04-24T00:00:00Z", ...extra,
})
const inf = (ruleId: string): RuleInfraction => ({
  ruleId, cellId: "c1", fileId: "f1", reason: "target-forbids", spans: [],
})
/** A target-side span over `text`; offsets are irrelevant to the hash. */
const span = (text: string, start = 0): InfractionSpan => ({
  side: "target", start, end: start + text.length, matchedText: text,
})
const multiSpan = (ruleId: string, texts: string[]): RuleInfraction => ({
  ...inf(ruleId),
  spans: texts.map((t, i) => span(t, i * 50)),
})

describe("isWaived", () => {
  it("returns true when a cell-wide waiver exists for the rule", () => {
    expect(isWaived([waiver("r1")], "r1")).toBe(true)
  })
  it("returns false when no waiver matches", () => {
    expect(isWaived([waiver("r2")], "r1")).toBe(false)
    expect(isWaived(undefined, "r1")).toBe(false)
  })
  // AQU-1740: this is the distinction the whole ticket rests on.
  it("returns false for a waiver that only names ONE finding", () => {
    expect(isWaived([waiver("r1", { matchHash: "h1" })], "r1")).toBe(false)
  })
})

describe("waiverKey / waivedKeys / isSpanWaived", () => {
  it("keys a cell-wide waiver by rule id alone", () => {
    expect(waiverKey("r1")).toBe("r1")
    expect(waiverKey("r1", undefined)).toBe("r1")
    expect(waiverKey("r1", null)).toBe("r1")
  })
  it("gives per-finding waivers of the same rule distinct keys", () => {
    expect(waiverKey("r1", "a")).not.toBe(waiverKey("r1", "b"))
    expect(waiverKey("r1", "a")).not.toBe(waiverKey("r1"))
  })
  it("collects one key per waiver", () => {
    const keys = waivedKeys([waiver("r1"), waiver("r2", { matchHash: "h" })])
    expect(keys).toEqual(new Set(["r1", waiverKey("r2", "h")]))
  })
  it("treats every span of a rule as waived when the rule is waived cell-wide", () => {
    const keys = waivedKeys([waiver("r1")])
    expect(isSpanWaived(keys, "r1", span("the the"))).toBe(true)
    expect(isSpanWaived(keys, "r1", span("and and"))).toBe(true)
  })
  it("waives only the named finding when the waiver carries a hash", () => {
    const keys = waivedKeys([waiver("r1", { matchHash: matchHash("the the") })])
    expect(isSpanWaived(keys, "r1", span("the the"))).toBe(true)
    expect(isSpanWaived(keys, "r1", span("and and"))).toBe(false)
  })
  it("never waives a span of a different rule", () => {
    const keys = waivedKeys([waiver("r1", { matchHash: matchHash("the the") })])
    expect(isSpanWaived(keys, "r2", span("the the"))).toBe(false)
  })
})

describe("spanMatchHash", () => {
  it("hashes the matched text", () => {
    expect(spanMatchHash(span("the the"))).toBe(matchHash("the the"))
  })
  it("is null for a span with no matchable text — only a cell-wide waiver fits", () => {
    expect(spanMatchHash(span(""))).toBeNull()
    expect(spanMatchHash({ side: "source", start: 0, end: 0, matchedText: "  " })).toBeNull()
  })
})

describe("waivedMatchHashes", () => {
  it("lists only the per-finding hashes of that rule", () => {
    const waivers = [
      waiver("r1", { matchHash: "a" }),
      waiver("r1", { matchHash: "b" }),
      waiver("r1"),
      waiver("r2", { matchHash: "c" }),
    ]
    expect(waivedMatchHashes(waivers, "r1")).toEqual(new Set(["a", "b"]))
    expect(waivedMatchHashes(undefined, "r1")).toEqual(new Set())
  })
})

describe("addWaiver", () => {
  it("appends a new cell-wide waiver", () => {
    const next = addWaiver([], { ruleId: "r1", reason: "ok here" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toEqual([{ ruleId: "r1", reason: "ok here", waivedBy: "alice", waivedAt: "2026-04-24T12:00:00Z" }])
  })
  it("replaces an existing waiver with the same key", () => {
    const prev = [waiver("r1", { reason: "old" })]
    const next = addWaiver(prev, { ruleId: "r1", reason: "new" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toHaveLength(1)
    expect(next[0].reason).toBe("new")
  })
  // AQU-1740: two findings of one rule are two decisions, so two rows.
  it("keeps per-finding waivers of the same rule side by side", () => {
    let next = addWaiver([], { ruleId: "r1", matchHash: "a" }, "alice", "2026-04-24T12:00:00Z")
    next = addWaiver(next, { ruleId: "r1", matchHash: "b" }, "alice", "2026-04-24T12:00:00Z")
    expect(next).toHaveLength(2)
    expect(next.map((w) => w.matchHash)).toEqual(["a", "b"])
  })
  it("does not let a per-finding waiver displace the cell-wide one", () => {
    const next = addWaiver([waiver("r1")], { ruleId: "r1", matchHash: "a" }, "alice")
    expect(next).toHaveLength(2)
  })
  it("omits matchHash entirely for a cell-wide waiver (no empty-string key on the wire)", () => {
    const next = addWaiver([], { ruleId: "r1" }, "alice", "2026-04-24T12:00:00Z")
    expect("matchHash" in next[0]).toBe(false)
  })
})

describe("removeWaiver", () => {
  it("removes a matching cell-wide waiver", () => {
    const next = removeWaiver([waiver("r1"), waiver("r2")], "r1")
    expect(next).toEqual([waiver("r2")])
  })
  it("is a no-op when no waiver matches", () => {
    const prev = [waiver("r2")]
    expect(removeWaiver(prev, "r1")).toBe(prev)
  })
  it("is key-exact: lifting one finding leaves the rule's other findings waived", () => {
    const prev = [waiver("r1", { matchHash: "a" }), waiver("r1", { matchHash: "b" })]
    const next = removeWaiver(prev, "r1", "a")
    expect(next).toEqual([waiver("r1", { matchHash: "b" })])
  })
  it("lifting the cell-wide waiver leaves per-finding ones standing", () => {
    const prev = [waiver("r1"), waiver("r1", { matchHash: "a" })]
    expect(removeWaiver(prev, "r1")).toEqual([waiver("r1", { matchHash: "a" })])
  })
})

describe("partitionInfractions", () => {
  it("splits infractions into active and waived", () => {
    const infractions = [inf("r1"), inf("r2"), inf("r3")]
    const waivers = [waiver("r2")]
    expect(partitionInfractions(infractions, waivers)).toEqual({
      active: [inf("r1"), inf("r3")],
      waived: [inf("r2")],
    })
  })

  it("returns the input untouched when there are no waivers", () => {
    const infractions = [inf("r1")]
    expect(partitionInfractions(infractions, [])).toEqual({ active: infractions, waived: [] })
    expect(partitionInfractions(infractions, undefined).active).toBe(infractions)
  })

  // ── AQU-1740 acceptance criterion ──────────────────────────────────────
  it("waiving ONE repeated word leaves a second repeated word in the same cell flagged", () => {
    const repeated = multiSpan("builtin:repeated-word", ["the the", "and and"])
    const waivers = [waiver("builtin:repeated-word", { matchHash: matchHash("the the") })]

    const { active, waived } = partitionInfractions([repeated], waivers)

    expect(active).toHaveLength(1)
    expect(active[0].spans.map((s) => s.matchedText)).toEqual(["and and"])
    expect(waived).toHaveLength(1)
    expect(waived[0].spans.map((s) => s.matchedText)).toEqual(["the the"])
  })

  it("a word repeated again later in the cell is covered — identical text is ONE decision", () => {
    const repeated = multiSpan("builtin:repeated-word", ["the the", "and and", "The  The"])
    const waivers = [waiver("builtin:repeated-word", { matchHash: matchHash("the the") })]

    const { active, waived } = partitionInfractions([repeated], waivers)

    expect(active[0].spans.map((s) => s.matchedText)).toEqual(["and and"])
    expect(waived[0].spans.map((s) => s.matchedText)).toEqual(["the the", "The  The"])
  })

  it("a cell-wide waiver still hides every finding of the rule (pre-AQU-1740 waivers keep working)", () => {
    const repeated = multiSpan("builtin:repeated-word", ["the the", "and and"])
    const { active, waived } = partitionInfractions([repeated], [waiver("builtin:repeated-word")])
    expect(active).toEqual([])
    expect(waived).toEqual([repeated])
  })

  it("drops the infraction from `active` entirely once its last finding is waived", () => {
    const repeated = multiSpan("r1", ["the the"])
    const { active, waived } = partitionInfractions([repeated], [
      waiver("r1", { matchHash: matchHash("the the") }),
    ])
    expect(active).toEqual([])
    expect(waived).toHaveLength(1)
  })

  it("leaves the infraction active when the waived hash matches none of its spans", () => {
    const repeated = multiSpan("r1", ["the the"])
    const result = partitionInfractions([repeated], [waiver("r1", { matchHash: "stale-hash" })])
    expect(result.active).toEqual([repeated])
    expect(result.waived).toEqual([])
  })

  it("an absence rule (no spans) can only be waived cell-wide", () => {
    const absence = inf("r1")
    const perFinding = partitionInfractions([absence], [waiver("r1", { matchHash: "h" })])
    expect(perFinding.active).toEqual([absence])
    const cellWide = partitionInfractions([absence], [waiver("r1")])
    expect(cellWide.waived).toEqual([absence])
  })

  it("re-derives placeholder-integrity's token list so each half names only its own spans", () => {
    const placeholders: RuleInfraction = {
      ruleId: "r1", cellId: "c1", fileId: "f1",
      reason: "builtin:placeholder-integrity",
      reasonParams: { tokens: "{name}, {count}", count: "2" },
      spans: [span("{name}"), span("{count}", 50)],
    }
    const { active, waived } = partitionInfractions([placeholders], [
      waiver("r1", { matchHash: matchHash("{name}") }),
    ])
    expect(active[0].reasonParams).toEqual({ tokens: "{count}", count: "1" })
    expect(waived[0].reasonParams).toEqual({ tokens: "{name}", count: "1" })
  })

  it("carries other reasons' params through untouched — they describe the cell, not the spans", () => {
    const mismatch: RuleInfraction = {
      ruleId: "r1", cellId: "c1", fileId: "f1",
      reason: "source-requires-target",
      reasonParams: { sourceCount: "3", targetCount: "1" },
      spans: [span("Lord"), span("Lord", 50)],
    }
    // Both spans normalize alike, so one waiver covers them and nothing splits.
    const { waived } = partitionInfractions([mismatch], [
      waiver("r1", { matchHash: matchHash("Lord") }),
    ])
    expect(waived[0].reasonParams).toEqual({ sourceCount: "3", targetCount: "1" })
  })

  it("does not mutate the infraction it splits", () => {
    const repeated = multiSpan("r1", ["the the", "and and"])
    partitionInfractions([repeated], [waiver("r1", { matchHash: matchHash("the the") })])
    expect(repeated.spans).toHaveLength(2)
  })
})

describe("distinctFindings", () => {
  it("lists each distinct match once, in first-appearance order", () => {
    const repeated = multiSpan("r1", ["and and", "the the"])
    expect(distinctFindings(repeated).map((f) => f.matchedText)).toEqual(["and and", "the the"])
  })
  it("folds identical matches into one finding and counts them", () => {
    const repeated = multiSpan("r1", ["the the", "The\n The", "and and"])
    const findings = distinctFindings(repeated)
    expect(findings).toHaveLength(2)
    expect(findings[0]).toMatchObject({ matchedText: "the the", spanCount: 2 })
    expect(findings[1]).toMatchObject({ matchedText: "and and", spanCount: 1 })
  })
  it("is empty for an absence rule, so callers fall back to one rule-level row", () => {
    expect(distinctFindings(inf("r1"))).toEqual([])
  })
  it("gives every finding the hash a waiver would carry", () => {
    const repeated = multiSpan("r1", ["the the"])
    expect(distinctFindings(repeated)[0].matchHash).toBe(matchHash("the the"))
  })
})
