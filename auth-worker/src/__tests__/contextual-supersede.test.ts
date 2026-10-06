// Supersession predicate (seam design §4.3).
// WHY these tests: supersession is the path users actually take — they answer
// a question by doing ordinary work, never seeing the card. If this predicate
// is too eager it closes questions that still need a human; if it is too shy
// the user gets interrupted for something already settled. The free-text case
// must NEVER auto-close, because deciding whether an edit answered a question
// is a judgment call, not a query (CLAUDE.md Rule 5).

import { describe, it, expect } from "vitest"
import { isSuperseded, type SupersessionSnapshot } from "../lib/contextual/supersede"

const base: SupersessionSnapshot = {
  decidedFactKeys: new Set<string>(),
  newestOpenFactQuestion: new Map<string, string>(),
  conceptsWithApprovedRenderings: new Set<string>(),
  validatedExamples: 0,
  briefFieldsAnswered: 0,
  readinessLevels: {
    terminology: "missing",
    brief: "missing",
    examples: "missing",
    rules: "partial",
    languages: "partial",
  },
}

describe("isSuperseded", () => {
  it("closes a terminology decision once its concept gains a rendering", () => {
    const d = { readinessItem: "terminology" as const, conceptId: "c-1" }
    expect(isSuperseded(d, base)).toBe(false)
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-1"]) }),
    ).toBe(true)
  })

  it("does not close a terminology decision when a DIFFERENT concept was settled", () => {
    const d = { readinessItem: "terminology" as const, conceptId: "c-1" }
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-2"]) }),
    ).toBe(false)
  })

  it("closes an examples decision only once the threshold is crossed", () => {
    const d = { readinessItem: "examples" as const, conceptId: null }
    expect(isSuperseded(d, { ...base, validatedExamples: 7 })).toBe(false)
    expect(isSuperseded(d, { ...base, validatedExamples: 8 })).toBe(true)
  })

  it("closes a brief decision once enough fields are answered", () => {
    const d = { readinessItem: "brief" as const, conceptId: null }
    expect(isSuperseded(d, { ...base, briefFieldsAnswered: 3 })).toBe(false)
    expect(isSuperseded(d, { ...base, briefFieldsAnswered: 4 })).toBe(true)
  })

  it("closes rules and languages decisions once they leave 'missing'", () => {
    const rules = { readinessItem: "rules" as const, conceptId: null }
    expect(
      isSuperseded(rules, {
        ...base,
        readinessLevels: { ...base.readinessLevels, rules: "missing" },
      }),
    ).toBe(false)
    expect(isSuperseded(rules, base)).toBe(true) // base has rules: "partial"
  })

  it("never auto-closes a free-text decision — that needs judgment, not a query", () => {
    const d = { readinessItem: null, conceptId: null }
    expect(
      isSuperseded(d, {
        ...base,
        validatedExamples: 999,
        conceptsWithApprovedRenderings: new Set(["c-1"]),
      }),
    ).toBe(false)
  })

  it("never closes a terminology decision that names no concept", () => {
    const d = { readinessItem: "terminology" as const, conceptId: null }
    expect(
      isSuperseded(d, { ...base, conceptsWithApprovedRenderings: new Set(["c-1"]) }),
    ).toBe(false)
  })

  // AQU-1691: fact questions. One open question per fact is the point: an
  // older wording left open beside a newer one makes a person answer twice,
  // and the second answer silently overwrites the first.
  describe("a question that names a fact key", () => {
    const older = { id: "q-1", readinessItem: "bible-fact" as const, conceptId: null, factKey: "measures" }
    const newer = { ...older, id: "q-2" }

    it("is superseded by a newer open question for the same key, and the newer one stays open", () => {
      const snap = { ...base, newestOpenFactQuestion: new Map([["measures", "q-2"]]) }
      expect(isSuperseded(older, snap)).toBe(true)
      expect(isSuperseded(newer, snap)).toBe(false)
    })

    it("is not superseded by a newer question for a different key", () => {
      const snap = { ...base, newestOpenFactQuestion: new Map([["headings", "q-9"]]) }
      expect(isSuperseded(older, snap)).toBe(false)
    })

    it("closes once the project has decided the key by any route", () => {
      expect(isSuperseded(newer, { ...base, decidedFactKeys: new Set(["measures"]) })).toBe(true)
    })

    it("wins over the readiness item: a fact key is checked as a fact even on a terminology question", () => {
      const keyed = { id: "q-3", readinessItem: "terminology" as const, conceptId: "c-1", factKey: "render.the-twelve" }
      expect(isSuperseded(keyed, { ...base, conceptsWithApprovedRenderings: new Set(["c-1"]) })).toBe(false)
    })

    it("never closes a bible-fact question that names no key", () => {
      const unkeyed = { id: "q-4", readinessItem: "bible-fact" as const, conceptId: null, factKey: null }
      expect(isSuperseded(unkeyed, { ...base, decidedFactKeys: new Set(["measures"]) })).toBe(false)
    })
  })
})
