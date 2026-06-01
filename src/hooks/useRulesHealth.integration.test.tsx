/**
 * BUG-TERM-6 regression test.
 *
 * Verifies that an active terminology concept produces a cell-level
 * infraction through the EXACT runtime path the editor uses:
 *   useRules(project) → rules → useHealth(fileCells, rules) → infractions
 *
 * A test that only calls compileConceptsToRules() is NOT sufficient —
 * this test must also exercise useRules and useHealth integration.
 */

import { describe, it, expect } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import { useRules } from "./useRules"
import { useHealth } from "./useHealth"
import type { CellData } from "./useCells"
import type { ProjectRecord } from "@/lib/parsers/types"
import type { Concept } from "@/lib/terminology/types"

// ---------------------------------------------------------------------------
// Minimal CellData factory
// ---------------------------------------------------------------------------

function makeCell(
  id: string,
  original: string,
  translated: string,
): CellData {
  return {
    id,
    fileId: "f1",
    cellLabel: id,
    original,
    originalHtml: undefined,
    translated,
    context: "",
    group: "",
    type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: translated ? "none" : "empty",
    endorsementCount: 0,
    activeValidators: [],
    validationHistory: [],
    history: [],
    threads: [],
  } as unknown as CellData
}

// ---------------------------------------------------------------------------
// Minimal ProjectRecord factory
// ---------------------------------------------------------------------------

function makeProject(terminology: Concept[] = []): ProjectRecord {
  return {
    id: "proj-1",
    name: "Test Project",
    sourceLanguage: "en",
    targetLanguage: "es",
    createdAt: "2024-01-01T00:00:00Z",
    files: [],
    members: [],
    terminology,
  }
}

// ---------------------------------------------------------------------------
// Active concept: sourceTerm "grace", preferred rendering "gracia"
// ---------------------------------------------------------------------------

function graceConceptActive(): Concept {
  return {
    id: "concept-grace",
    sourceTerm: "grace",
    renderings: [{ rendering: "gracia", status: "preferred" }],
    status: "active",
    createdAt: "2024-01-01T00:00:00Z",
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BUG-TERM-6 — terminology rules reach useHealth infractions via useRules", () => {
  it("produces a source-requires-target infraction through useRules → useHealth for an active concept", async () => {
    // Cell: source has "grace", target doesn't have "gracia" — should fire
    const cell = makeCell("cell-1", "the grace of God is sufficient", "la bondad de Dios es suficiente")
    const fileCells = new Map([["f1", [cell]]])
    const project = makeProject([graceConceptActive()])

    // Render both hooks together (simulates the editor path in ProjectWorkspace)
    const refresh = () => {}
    const { result } = renderHook(() => {
      const { rules } = useRules(project, refresh)
      const health = useHealth(fileCells, rules)
      return { rules, health }
    })

    await waitFor(() => {
      // At minimum, the compiled terminology rule must be present in rules
      const { rules, health } = result.current
      const termRule = rules.find((r) => r.id === "term:concept-grace:approved")
      expect(termRule).toBeDefined()
      expect(termRule?.enabled).toBe(true)

      // The infraction must fire for the violating cell
      const infractions = health.infractions.get("cell-1")
      expect(infractions).toBeDefined()
      expect(infractions?.length).toBeGreaterThan(0)
      const termInfraction = infractions?.find((i) => i.ruleId === "term:concept-grace:approved")
      expect(termInfraction).toBeDefined()
    })
  })

  it("does NOT produce an infraction when the target contains the preferred rendering", async () => {
    // Cell: source has "grace", target DOES have "gracia" — should NOT fire
    const cell = makeCell("cell-1", "the grace of God is sufficient", "la gracia de Dios es suficiente")
    const fileCells = new Map([["f1", [cell]]])
    const project = makeProject([graceConceptActive()])

    const refresh = () => {}
    const { result } = renderHook(() => {
      const { rules } = useRules(project, refresh)
      const health = useHealth(fileCells, rules)
      return { rules, health }
    })

    await waitFor(() => {
      const { health } = result.current
      const infractions = health.infractions.get("cell-1")
      // No infraction: target satisfies the requirement
      const termInfraction = infractions?.find((i) => i.ruleId === "term:concept-grace:approved")
      expect(termInfraction).toBeUndefined()
    })
  })

  it("terminology rules are absent when project.terminology is undefined (no false positives)", async () => {
    // No terminology in project — rules array must not contain any term: rules
    const cell = makeCell("cell-1", "the grace of God", "wrong translation")
    const fileCells = new Map([["f1", [cell]]])
    const project = makeProject([]) // no terminology

    const refresh = () => {}
    const { result } = renderHook(() => {
      const { rules } = useRules(project, refresh)
      const health = useHealth(fileCells, rules)
      return { rules, health }
    })

    await waitFor(() => {
      const { rules, health } = result.current
      const termRules = rules.filter((r) => r.id.startsWith("term:"))
      expect(termRules).toHaveLength(0)
      const infractions = health.infractions.get("cell-1")
      const termInfraction = infractions?.find((i) => i.ruleId.startsWith("term:"))
      expect(termInfraction).toBeUndefined()
    })
  })

  it("draft concepts do not produce infractions", async () => {
    const draftConcept: Concept = { ...graceConceptActive(), status: "draft" }
    const cell = makeCell("cell-1", "the grace of God", "wrong translation without gracia")
    const fileCells = new Map([["f1", [cell]]])
    const project = makeProject([draftConcept])

    const refresh = () => {}
    const { result } = renderHook(() => {
      const { rules } = useRules(project, refresh)
      const health = useHealth(fileCells, rules)
      return { rules, health }
    })

    await waitFor(() => {
      const { rules, health } = result.current
      const termRules = rules.filter((r) => r.id.startsWith("term:"))
      expect(termRules).toHaveLength(0)
      const infractions = health.infractions.get("cell-1")
      const termInfraction = infractions?.find((i) => i.ruleId.startsWith("term:"))
      expect(termInfraction).toBeUndefined()
    })
  })

  it("terminology rules arrive when project updates from no-terminology to has-terminology (async load simulation)", async () => {
    // Simulate the timing issue: editor mounts with project (no terminology yet),
    // then terminology loads in and is set on the project.
    const cell = makeCell("cell-1", "the grace of God", "wrong translation")
    const fileCells = new Map([["f1", [cell]]])

    const projectWithout = makeProject([])
    const projectWith = makeProject([graceConceptActive()])

    const refresh = () => {}
    let currentProject = projectWithout

    const { result, rerender } = renderHook(() => {
      const { rules } = useRules(currentProject, refresh)
      const health = useHealth(fileCells, rules)
      return { rules, health }
    })

    // Initially: no terminology rules
    await waitFor(() => {
      const { rules } = result.current
      const termRules = rules.filter((r) => r.id.startsWith("term:"))
      expect(termRules).toHaveLength(0)
    })

    // Now simulate project re-render with terminology loaded
    act(() => {
      currentProject = projectWith
    })
    rerender()

    // After update: terminology rule fires
    await waitFor(() => {
      const { health } = result.current
      const infractions = health.infractions.get("cell-1")
      const termInfraction = infractions?.find((i) => i.ruleId === "term:concept-grace:approved")
      expect(termInfraction).toBeDefined()
    })
  })
})
