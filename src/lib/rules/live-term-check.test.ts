import { describe, it, expect } from "vitest"
import { selectTermRules, computeLiveTermInfractions, mergeBlotInfractions } from "./live-term-check"
import type { RuleInfraction, TranslationRule } from "@/lib/parsers/types"
import type { CellData } from "@/hooks/useCells"

// A terminology rule (id prefixed `term:`) that forbids the rendering "verboten"
// in the target — the shape compileConceptsToRules emits for a forbidden
// rendering. `u` flag is applied by rule-engine for term: rules.
const termRule: TranslationRule = {
  id: "term:concept-1:forbidden:verboten",
  name: "sample → verboten (forbidden)",
  description: "Forbidden rendering of 'sample'",
  severity: "major",
  source: "algorithmic",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "verboten" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

const disabledTermRule: TranslationRule = { ...termRule, id: "term:concept-2", enabled: false }

// A non-terminology (user-authored) rule — must never be treated as a term rule.
const userRule: TranslationRule = {
  id: "user:no-tabs",
  name: "No tabs",
  description: "Target must not contain tabs",
  severity: "minor",
  source: "user",
  scope: "project",
  check: { type: "target-forbids", targetPattern: "\\t" },
  enabled: true,
  createdAt: "2026-01-01T00:00:00Z",
}

function makeCell(overrides: Partial<CellData> = {}): CellData {
  return {
    id: "cell-1",
    fileId: "file-1",
    original: "This is a sample.",
    translated: "",
    context: "GEN 1:1",
    group: "GEN 1",
    type: "text",
    status: "empty",
    validationStatus: "none",
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
    ...overrides,
  }
}

describe("selectTermRules", () => {
  it("keeps only enabled rules whose id starts with `term:`", () => {
    const picked = selectTermRules([termRule, disabledTermRule, userRule])
    expect(picked.map((r) => r.id)).toEqual(["term:concept-1:forbidden:verboten"])
  })

  it("returns empty when there are no terminology rules", () => {
    expect(selectTermRules([userRule])).toEqual([])
  })
})

describe("computeLiveTermInfractions", () => {
  it("flags a forbidden rendering typed into an as-yet-empty (status:empty) cell", () => {
    // The regression this guards: checkRulesForCell short-circuits on an
    // `empty` status, so without the status promotion a just-typed forbidden
    // term would produce no blot until the commit landed.
    const cell = makeCell({ status: "empty", translated: "" })
    const infractions = computeLiveTermInfractions(cell, "verboten", [termRule])
    expect(infractions).toHaveLength(1)
    expect(infractions[0].ruleId).toBe("term:concept-1:forbidden:verboten")
    expect(infractions[0].spans[0]).toMatchObject({ side: "target", start: 0, end: 8 })
  })

  it("returns no infractions when the live buffer is clean", () => {
    const cell = makeCell()
    expect(computeLiveTermInfractions(cell, "bonjour", [termRule])).toEqual([])
  })

  it("returns [] when there are no term rules (skips the check entirely)", () => {
    const cell = makeCell()
    expect(computeLiveTermInfractions(cell, "verboten", [])).toEqual([])
  })
})

describe("mergeBlotInfractions", () => {
  const committedTerm: RuleInfraction = {
    ruleId: "term:concept-1:forbidden:verboten",
    cellId: "cell-1",
    fileId: "file-1",
    message: "stale term span",
    spans: [{ side: "target", start: 99, end: 107, matchedText: "verboten" }],
  }
  const committedUser: RuleInfraction = {
    ruleId: "user:no-tabs",
    cellId: "cell-1",
    fileId: "file-1",
    message: "tab present",
    spans: [{ side: "target", start: 3, end: 4, matchedText: "\t" }],
  }
  const liveTerm: RuleInfraction = {
    ruleId: "term:concept-1:forbidden:verboten",
    cellId: "cell-1",
    fileId: "file-1",
    message: "fresh term span",
    spans: [{ side: "target", start: 0, end: 8, matchedText: "verboten" }],
  }

  it("replaces committed term infractions with the live ones, keeping non-term ones", () => {
    const merged = mergeBlotInfractions([committedTerm, committedUser], [liveTerm])
    // The stale committed term infraction is gone; the fresh live one is in.
    expect(merged).toHaveLength(2)
    expect(merged).toContain(committedUser)
    expect(merged).toContain(liveTerm)
    expect(merged).not.toContain(committedTerm)
  })

  it("drops committed term infractions when the live buffer has none left", () => {
    // User fixed the term while typing → blot must clear immediately, not wait
    // for the next commit.
    const merged = mergeBlotInfractions([committedTerm, committedUser], [])
    expect(merged).toEqual([committedUser])
  })
})
