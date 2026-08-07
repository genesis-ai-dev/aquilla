import { describe, it, expect } from "vitest"
import {
  primaryRendering,
  setPrimaryRendering,
  partitionConcepts,
  canEditTermbase,
} from "./glossary-view"
import type { Concept } from "./types"

function c(partial: Partial<Concept>): Concept {
  return {
    id: "x",
    sourceTerm: "grace",
    renderings: [],
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  }
}

describe("primaryRendering", () => {
  it("returns the first preferred rendering when present", () => {
    const concept = c({
      renderings: [
        { rendering: "gracia", status: "admitted" },
        { rendering: "favor", status: "preferred" },
      ],
    })
    expect(primaryRendering(concept)?.rendering).toBe("favor")
  })

  it("falls back to the first rendering when none are preferred", () => {
    const concept = c({ renderings: [{ rendering: "gracia", status: "admitted" }] })
    expect(primaryRendering(concept)?.rendering).toBe("gracia")
  })

  it("returns null when there are no renderings", () => {
    expect(primaryRendering(c({ renderings: [] }))).toBeNull()
  })
})

describe("setPrimaryRendering", () => {
  it("mutates the existing preferred rendering", () => {
    const concept = c({
      renderings: [
        { rendering: "favor", status: "preferred" },
        { rendering: "gracia", status: "admitted" },
      ],
    })
    const next = setPrimaryRendering(concept, "merced")
    expect(next.renderings).toEqual([
      { rendering: "merced", status: "preferred" },
      { rendering: "gracia", status: "admitted" },
    ])
  })

  it("mutates the first rendering when none is preferred", () => {
    const concept = c({ renderings: [{ rendering: "gracia", status: "admitted" }] })
    const next = setPrimaryRendering(concept, "merced")
    expect(next.renderings).toEqual([{ rendering: "merced", status: "admitted" }])
  })

  it("adds a preferred rendering when there are none", () => {
    const next = setPrimaryRendering(c({ renderings: [] }), "merced")
    expect(next.renderings).toEqual([{ rendering: "merced", status: "preferred" }])
  })

  it("does not mutate the input concept", () => {
    const concept = c({ renderings: [{ rendering: "favor", status: "preferred" }] })
    setPrimaryRendering(concept, "merced")
    expect(concept.renderings[0].rendering).toBe("favor")
  })
})

describe("partitionConcepts", () => {
  it("splits by lifecycle status", () => {
    const parts = partitionConcepts([
      c({ id: "a", status: "active" }),
      c({ id: "d", status: "draft" }),
      c({ id: "x", status: "deprecated" }),
      c({ id: "a2", status: "active" }),
    ])
    expect(parts.active.map((x) => x.id)).toEqual(["a", "a2"])
    expect(parts.suggested.map((x) => x.id)).toEqual(["d"])
    expect(parts.archived.map((x) => x.id)).toEqual(["x"])
  })
})

describe("canEditTermbase", () => {
  it("allows local projects regardless of role", () => {
    expect(canEditTermbase(null, false)).toBe(true)
    expect(canEditTermbase({ level: 100 }, false)).toBe(true)
  })
  it("allows when role not yet cached on a cloud project", () => {
    expect(canEditTermbase(null, true)).toBe(true)
  })
  // AQU-816 regression guard: the term-base floor is contributor (400), not
  // project_lead (500) — translators curate terms themselves.
  it("allows contributor and above on a cloud project", () => {
    expect(canEditTermbase({ level: 400 }, true)).toBe(true)
    expect(canEditTermbase({ level: 500 }, true)).toBe(true)
    expect(canEditTermbase({ level: 600 }, true)).toBe(true)
  })
  it("keeps reviewer and below read-only on a cloud project", () => {
    expect(canEditTermbase({ level: 300 }, true)).toBe(false)
    expect(canEditTermbase({ level: 200 }, true)).toBe(false)
    expect(canEditTermbase({ level: 100 }, true)).toBe(false)
  })
})
