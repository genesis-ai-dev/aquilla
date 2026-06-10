import { describe, it, expect } from "vitest"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "./types"
import {
  addConcept,
  updateConcept,
  deleteConcept,
  mergeConcepts,
  approveConcept,
  rejectConcept,
} from "./store"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(terminology: Concept[] = []): ProjectRecord {
  return { id: "proj-1", name: "Test", terminology } as unknown as ProjectRecord
}

function makeConcept(overrides: Partial<Concept> = {}): Concept {
  return {
    id: "c1",
    sourceTerm: "spirit",
    renderings: [{ rendering: "spirit", status: "preferred" }],
    notes: "A note",
    status: "active",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// addConcept
// ---------------------------------------------------------------------------

describe("addConcept", () => {
  it("appends a new concept with a generated id", () => {
    const project = makeProject()
    const result = addConcept(project, {
      sourceTerm: "spirit",
      renderings: [{ rendering: "spirit", status: "preferred" }],
      status: "draft",
    })
    expect(result.terminology).toHaveLength(1)
    expect(result.terminology![0].id).toBeTruthy()
    expect(result.terminology![0].sourceTerm).toBe("spirit")
  })

  it("preserves a provided id", () => {
    const project = makeProject()
    const result = addConcept(project, {
      id: "custom-id",
      sourceTerm: "spirit",
      renderings: [],
      status: "draft",
    })
    expect(result.terminology![0].id).toBe("custom-id")
  })
})

// ---------------------------------------------------------------------------
// updateConcept
// ---------------------------------------------------------------------------

describe("updateConcept", () => {
  it("patches only the specified fields", () => {
    const c = makeConcept()
    const project = makeProject([c])
    const result = updateConcept(project, "c1", { sourceTerm: "breath" })
    expect(result.terminology![0].sourceTerm).toBe("breath")
    // unchanged fields survive
    expect(result.terminology![0].notes).toBe("A note")
  })

  it("is a no-op for unknown id", () => {
    const project = makeProject([makeConcept()])
    const result = updateConcept(project, "unknown", { sourceTerm: "x" })
    expect(result.terminology![0].sourceTerm).toBe("spirit")
  })
})

// ---------------------------------------------------------------------------
// deleteConcept
// ---------------------------------------------------------------------------

describe("deleteConcept", () => {
  it("removes the concept with the given id", () => {
    const project = makeProject([makeConcept()])
    const result = deleteConcept(project, "c1")
    expect(result.terminology).toHaveLength(0)
  })

  it("leaves other concepts intact", () => {
    const c2 = makeConcept({ id: "c2", sourceTerm: "wind" })
    const project = makeProject([makeConcept(), c2])
    const result = deleteConcept(project, "c1")
    expect(result.terminology).toHaveLength(1)
    expect(result.terminology![0].id).toBe("c2")
  })
})

// ---------------------------------------------------------------------------
// mergeConcepts
// ---------------------------------------------------------------------------

describe("mergeConcepts", () => {
  it("merges renderings from both concepts into survivor", () => {
    const c1 = makeConcept({
      id: "c1",
      sourceTerm: "spirit",
      renderings: [{ rendering: "spirit", status: "preferred" }],
      notes: "note1",
    })
    const c2 = makeConcept({
      id: "c2",
      sourceTerm: "breath",
      renderings: [
        { rendering: "breath", status: "admitted" },
        { rendering: "wind", status: "admitted" },
      ],
      notes: "note2",
    })
    const project = makeProject([c1, c2])
    const result = mergeConcepts(project, ["c1", "c2"], "c1")

    expect(result.terminology).toHaveLength(1)
    const survivor = result.terminology![0]
    expect(survivor.id).toBe("c1")
    // survivor gets its own rendering + both from c2
    expect(survivor.renderings.map((r) => r.rendering)).toContain("spirit")
    expect(survivor.renderings.map((r) => r.rendering)).toContain("breath")
    expect(survivor.renderings.map((r) => r.rendering)).toContain("wind")
    // notes concatenated
    expect(survivor.notes).toBe("note1 | note2")
  })

  it("deduplicates renderings case-insensitively, survivor wins", () => {
    const c1 = makeConcept({
      id: "c1",
      renderings: [{ rendering: "Spirit", status: "preferred" }],
      notes: undefined,
    })
    const c2 = makeConcept({
      id: "c2",
      renderings: [{ rendering: "spirit", status: "admitted" }],
      notes: undefined,
    })
    const project = makeProject([c1, c2])
    const result = mergeConcepts(project, ["c1", "c2"], "c1")

    // Only one rendering for "spirit" (the survivor's version)
    const renderings = result.terminology![0].renderings
    const spiritRenderings = renderings.filter(
      (r) => r.rendering.toLowerCase() === "spirit",
    )
    expect(spiritRenderings).toHaveLength(1)
    expect(spiritRenderings[0].status).toBe("preferred") // survivor wins
  })

  it("removes merged-away concept from project", () => {
    const c1 = makeConcept({ id: "c1" })
    const c2 = makeConcept({ id: "c2", sourceTerm: "wind" })
    const c3 = makeConcept({ id: "c3", sourceTerm: "breath" })
    const project = makeProject([c1, c2, c3])
    const result = mergeConcepts(project, ["c1", "c2"], "c1")
    expect(result.terminology).toHaveLength(2)
    const ids = result.terminology!.map((c) => c.id)
    expect(ids).toContain("c1")
    expect(ids).toContain("c3")
    expect(ids).not.toContain("c2")
  })

  it("deduplicates notes (unique parts only)", () => {
    const c1 = makeConcept({ id: "c1", notes: "shared note" })
    const c2 = makeConcept({ id: "c2", notes: "shared note" })
    const project = makeProject([c1, c2])
    const result = mergeConcepts(project, ["c1", "c2"], "c1")
    expect(result.terminology![0].notes).toBe("shared note")
  })

  it("throws when fewer than 2 ids are provided", () => {
    const project = makeProject([makeConcept()])
    expect(() => mergeConcepts(project, ["c1"], "c1")).toThrow(
      "mergeConcepts requires at least 2 concept ids.",
    )
  })

  it("throws when survivorId is not in mergeIds", () => {
    const c1 = makeConcept({ id: "c1" })
    const c2 = makeConcept({ id: "c2" })
    const project = makeProject([c1, c2])
    expect(() => mergeConcepts(project, ["c1", "c2"], "c3")).toThrow(
      "survivorId must be one of the mergeIds.",
    )
  })

  it("throws when a concept id does not exist", () => {
    const project = makeProject([makeConcept()])
    expect(() => mergeConcepts(project, ["c1", "missing"], "c1")).toThrow(
      "Concept missing not found.",
    )
  })
})

// ---------------------------------------------------------------------------
// approveConcept
// ---------------------------------------------------------------------------

describe("approveConcept", () => {
  it("sets status to active", () => {
    const c = makeConcept({ status: "draft" })
    const project = makeProject([c])
    const result = approveConcept(project, "c1")
    expect(result.terminology![0].status).toBe("active")
  })

  it("is a no-op for unknown id", () => {
    const project = makeProject([makeConcept({ status: "draft" })])
    const result = approveConcept(project, "unknown")
    expect(result.terminology![0].status).toBe("draft")
  })
})

// ---------------------------------------------------------------------------
// rejectConcept
// ---------------------------------------------------------------------------

describe("rejectConcept", () => {
  it("deletes the concept by default (mode=delete)", () => {
    const project = makeProject([makeConcept({ status: "draft" })])
    const result = rejectConcept(project, "c1")
    expect(result.terminology).toHaveLength(0)
  })

  it("sets status to deprecated when mode=deprecate", () => {
    const project = makeProject([makeConcept({ status: "draft" })])
    const result = rejectConcept(project, "c1", "deprecate")
    expect(result.terminology![0].status).toBe("deprecated")
  })
})
