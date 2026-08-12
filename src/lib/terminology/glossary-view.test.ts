import { describe, it, expect } from "vitest"
import {
  primaryRendering,
  setPrimaryRendering,
  partitionConcepts,
  canEditTermbase,
  resolveTermbaseEditFloor,
  DEFAULT_TERMBASE_EDIT_MIN_ROLE,
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
  it("requires level >= 500 on a cloud project", () => {
    expect(canEditTermbase({ level: 400 }, true)).toBe(false)
    expect(canEditTermbase({ level: 500 }, true)).toBe(true)
  })

  // AQU-822: the floor is org-configurable (termbaseEditMinRole), so BGP can
  // let translators own terminology while other orgs keep the default.
  it("honours an org floor lowered to contributor (400)", () => {
    expect(canEditTermbase({ level: 400 }, true, 400)).toBe(true)
    expect(canEditTermbase({ level: 300 }, true, 400)).toBe(false)
  })
  it("honours an org floor raised to maintainer (600)", () => {
    expect(canEditTermbase({ level: 500 }, true, 600)).toBe(false)
    expect(canEditTermbase({ level: 600 }, true, 600)).toBe(true)
  })
  it("falls back to the 500 default for an absent or out-of-ladder floor", () => {
    expect(canEditTermbase({ level: 400 }, true, undefined)).toBe(false)
    expect(canEditTermbase({ level: 400 }, true, null)).toBe(false)
    // A misconfigured floor must be a no-op, never an open door.
    expect(canEditTermbase({ level: 400 }, true, 0)).toBe(false)
    expect(canEditTermbase({ level: 400 }, true, 9999)).toBe(false)
    expect(canEditTermbase({ level: 500 }, true, 9999)).toBe(true)
  })
  it("keeps the local-project and unknown-role escape hatches under any floor", () => {
    expect(canEditTermbase({ level: 100 }, false, 600)).toBe(true)
    expect(canEditTermbase(null, true, 600)).toBe(true)
  })
})

describe("resolveTermbaseEditFloor", () => {
  it("returns the configured floor when it is a valid role level", () => {
    expect(resolveTermbaseEditFloor(400)).toBe(400)
    expect(resolveTermbaseEditFloor(600)).toBe(600)
  })
  it("returns the project_lead default for absent / invalid values", () => {
    expect(resolveTermbaseEditFloor(undefined)).toBe(DEFAULT_TERMBASE_EDIT_MIN_ROLE)
    expect(resolveTermbaseEditFloor(null)).toBe(DEFAULT_TERMBASE_EDIT_MIN_ROLE)
    expect(resolveTermbaseEditFloor(Number.NaN)).toBe(DEFAULT_TERMBASE_EDIT_MIN_ROLE)
    expect(resolveTermbaseEditFloor(99)).toBe(DEFAULT_TERMBASE_EDIT_MIN_ROLE)
    expect(resolveTermbaseEditFloor(701)).toBe(DEFAULT_TERMBASE_EDIT_MIN_ROLE)
  })
})
