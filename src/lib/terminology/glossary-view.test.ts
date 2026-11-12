import { describe, it, expect } from "vitest"
import {
  primaryRendering,
  setPrimaryRendering,
  partitionConcepts,
  canEditTermbase,
  canEditTermCells,
  canSuggestTerm,
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
  it("allows when no role is known yet (record loading, or a local project)", () => {
    expect(canEditTermbase(null)).toBe(true)
    expect(canEditTermbase(undefined)).toBe(true)
  })
  it("requires level >= 500 by default", () => {
    expect(canEditTermbase({ level: 400 })).toBe(false)
    expect(canEditTermbase({ level: 500 })).toBe(true)
  })
  // AQU-208: this helper used to take a `hasOrigin` flag and allow everything
  // when it was false. Server-hydrated records never carry `origin`, so the
  // live glossary handed a viewer every termbase control. A known role is the
  // whole question — there is no second argument that can waive it.
  it("enforces a known role for a viewer / commenter / reviewer / contributor", () => {
    for (const level of [100, 200, 300, 400]) {
      expect(canEditTermbase({ level })).toBe(false)
    }
  })

  // AQU-822: the floor is org-configurable (termbaseEditMinRole), so BGP can
  // let translators own terminology while other orgs keep the default.
  it("honours an org floor lowered to contributor (400)", () => {
    expect(canEditTermbase({ level: 400 }, 400)).toBe(true)
    expect(canEditTermbase({ level: 300 }, 400)).toBe(false)
  })
  it("honours an org floor raised to maintainer (600)", () => {
    expect(canEditTermbase({ level: 500 }, 600)).toBe(false)
    expect(canEditTermbase({ level: 600 }, 600)).toBe(true)
  })
  it("falls back to the 500 default for an absent or out-of-ladder floor", () => {
    expect(canEditTermbase({ level: 400 }, undefined)).toBe(false)
    expect(canEditTermbase({ level: 400 }, null)).toBe(false)
    // A misconfigured floor must be a no-op, never an open door.
    expect(canEditTermbase({ level: 400 }, 0)).toBe(false)
    expect(canEditTermbase({ level: 400 }, 9999)).toBe(false)
    expect(canEditTermbase({ level: 500 }, 9999)).toBe(true)
  })
  it("keeps the unknown-role escape hatch under any floor", () => {
    expect(canEditTermbase(null, 600)).toBe(true)
  })
})

// AQU-872: suggesting a term is a strictly lower bar than managing the
// termbase, and it is deliberately INDEPENDENT of the org's floor — raising
// the floor restricts who may approve, never who may propose.
describe("canSuggestTerm", () => {
  it("lets a contributor (400) and above propose a term", () => {
    expect(canSuggestTerm({ level: 400 })).toBe(true)
    expect(canSuggestTerm({ level: 500 })).toBe(true)
    expect(canSuggestTerm({ level: 700 })).toBe(true)
  })
  it("refuses a viewer / commenter / reviewer", () => {
    expect(canSuggestTerm({ level: 100 })).toBe(false)
    expect(canSuggestTerm({ level: 200 })).toBe(false)
    expect(canSuggestTerm({ level: 300 })).toBe(false)
  })
  it("keeps the unknown-role escape hatch", () => {
    expect(canSuggestTerm(null)).toBe(true)
    expect(canSuggestTerm(undefined)).toBe(true)
  })
  it("stays open to a contributor however high the org raises the MANAGEMENT floor", () => {
    // The two questions are asked of different things: the floor gates
    // approving a term into force, and a draft forces nothing.
    expect(canEditTermbase({ level: 400 }, 600)).toBe(false)
    expect(canSuggestTerm({ level: 400 })).toBe(true)
  })
})

// AQU-208 C3: the drill-down (C2) lets contributors fix target cells while the
// termbase definitions stay with project_lead+. These two gates live on the
// same page, so they are asserted against the same role ladder here.
describe("canEditTermCells", () => {
  it("lets a contributor (400) edit cells in the drill-down", () => {
    expect(canEditTermCells({ level: 400 })).toBe(true)
  })
  it("keeps the drill-down read-only for a viewer / commenter / reviewer", () => {
    expect(canEditTermCells({ level: 100 })).toBe(false)
    expect(canEditTermCells({ level: 200 })).toBe(false)
    expect(canEditTermCells({ level: 300 })).toBe(false)
  })
  it("allows a project_lead and above", () => {
    expect(canEditTermCells({ level: 500 })).toBe(true)
    expect(canEditTermCells({ level: 700 })).toBe(true)
  })
  it("keeps the unknown-role escape hatch", () => {
    // No syncRole yet — optimistic, the same way canEditTermbase is, so the
    // two gates on this page agree. The server (and the outbox's own
    // role-policy mirror) still refuses a commit the caller may not make.
    expect(canEditTermCells(null)).toBe(true)
    expect(canEditTermCells(undefined)).toBe(true)
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
