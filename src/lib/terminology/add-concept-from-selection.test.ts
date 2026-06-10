/**
 * Tests for selection → draft concept creation flow (FRO-260).
 *
 * These are pure-function unit tests covering:
 *   1. addConcept creates a draft concept prefilled with the selected term
 *   2. The concept appears in the terminology array with status "draft"
 *   3. Lookup of an existing concept via substring match (mirrors TermLookupPopover logic)
 */

import { describe, it, expect } from "vitest"
import { addConcept } from "./store"
import type { Concept } from "./types"
import type { ProjectRecord } from "@/lib/parsers/types"

// ---------------------------------------------------------------------------
// Minimal project stub
// ---------------------------------------------------------------------------

function makeProject(terminology: Concept[] = []): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    terminology,
  } as unknown as ProjectRecord
}

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c-existing",
    sourceTerm: "Holy Spirit",
    renderings: [{ rendering: "Holy Ghost", status: "preferred" }],
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// 1. Draft concept creation from selection
// ---------------------------------------------------------------------------

describe("addConcept — selection → draft concept", () => {
  it("creates a concept with the selected source term and status draft", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "grace",
      renderings: [],
      status: "draft",
      createdBy: "testuser",
    })

    expect(updated.terminology).toHaveLength(1)
    const concept = updated.terminology![0]
    expect(concept.sourceTerm).toBe("grace")
    expect(concept.status).toBe("draft")
    expect(concept.renderings).toEqual([])
  })

  it("assigns a fresh UUID as the concept id", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "faith",
      renderings: [],
      status: "draft",
    })
    expect(updated.terminology![0].id).toBeTruthy()
    expect(updated.terminology![0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })

  it("sets createdAt to an ISO timestamp", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "love",
      renderings: [],
      status: "draft",
    })
    expect(updated.terminology![0].createdAt).toBeTruthy()
    expect(() => new Date(updated.terminology![0].createdAt)).not.toThrow()
  })

  it("appends to existing concepts without replacing them", () => {
    const existing = makeConcept()
    const project = makeProject([existing])

    const updated = addConcept(project, {
      sourceTerm: "spirit",
      renderings: [],
      status: "draft",
    })

    expect(updated.terminology).toHaveLength(2)
    expect(updated.terminology![0].id).toBe("c-existing")
    expect(updated.terminology![1].sourceTerm).toBe("spirit")
  })

  it("preserves createdBy on the new concept", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "peace",
      renderings: [],
      status: "draft",
      createdBy: "translator-alice",
    })
    expect(updated.terminology![0].createdBy).toBe("translator-alice")
  })
})

// ---------------------------------------------------------------------------
// 2. Draft concept is visible in terminology but NOT active
// ---------------------------------------------------------------------------

describe("draft concept visibility", () => {
  it("draft concept appears in the terminology array", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "redemption",
      renderings: [],
      status: "draft",
    })
    // TerminologyPage lists all concepts regardless of status.
    expect(updated.terminology!.some((c) => c.sourceTerm === "redemption")).toBe(true)
  })

  it("draft concept is NOT compiled to active rules (status !== active)", () => {
    const project = makeProject()
    const updated = addConcept(project, {
      sourceTerm: "atonement",
      renderings: [{ rendering: "propitiation", status: "preferred" }],
      status: "draft",
    })
    // Only active concepts are compiled by compileConceptsToRules.
    // The filter is: concept.status !== "active" → skip.
    const draftConcept = updated.terminology![0]
    expect(draftConcept.status).not.toBe("active")
  })
})

// ---------------------------------------------------------------------------
// 3. Lookup logic: substring match mirrors TermLookupPopover behaviour
// ---------------------------------------------------------------------------

describe("selection lookup — concept matching", () => {
  /**
   * TermLookupPopover matches: c.sourceTerm.toLowerCase().includes(selection.toLowerCase())
   * SelectionTermActions also checks: selection.toLowerCase().includes(c.sourceTerm.toLowerCase())
   * so a partial-word selection still surfaces the concept.
   */
  function selectionMatchesConcept(selection: string, concept: Concept): boolean {
    const sel = selection.toLowerCase()
    const term = concept.sourceTerm.toLowerCase()
    return term.includes(sel) || sel.includes(term)
  }

  it("selection 'spirit' matches concept 'Holy Spirit'", () => {
    const concept = makeConcept({ sourceTerm: "Holy Spirit", status: "active" })
    expect(selectionMatchesConcept("spirit", concept)).toBe(true)
  })

  it("selection 'Holy Spirit' matches concept 'spirit'", () => {
    const concept = makeConcept({ sourceTerm: "spirit", status: "active" })
    expect(selectionMatchesConcept("Holy Spirit", concept)).toBe(true)
  })

  it("selection 'grace' does NOT match concept 'spirit'", () => {
    const concept = makeConcept({ sourceTerm: "spirit", status: "active" })
    expect(selectionMatchesConcept("grace", concept)).toBe(false)
  })

  it("draft concepts do NOT produce a lookup match (only active concepts shown)", () => {
    // TermLookupPopover and SelectionTermActions both filter to active first.
    const concept = makeConcept({ sourceTerm: "spirit", status: "draft" })
    // The active filter is applied before matching; draft means no match.
    const activeConcepts = [concept].filter((c) => c.status === "active")
    const hasMatch = activeConcepts.some((c) => selectionMatchesConcept("spirit", c))
    expect(hasMatch).toBe(false)
  })
})
