// AQU-2654: a file that mentions many glossary terms for the first time makes
// the rule pass compile a regex per term. The pass does a bounded amount of
// that inside render and checks the rest of the file in the background.

import { describe, it, expect } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useHealth } from "./useHealth"
import type { CellData } from "./useCells"
import { checkRules } from "@/lib/rules/rule-engine"
import { compileConceptsToRules } from "@/lib/terminology/compile"
import { conceptPatternsCompiled } from "@/lib/terminology/match"
import type { Concept } from "@/lib/terminology/types"

function cell(id: string, original: string, translated: string): CellData {
  return {
    id, cellLabel: id, fileId: "f", original, originalHtml: undefined, translated,
    context: "", group: "", type: "text",
    status: translated ? "unvalidated" : "empty",
    validationStatus: translated ? "none" : "empty",
    endorsementCount: 0,
    activeValidators: [], history: [], threads: [], validationHistory: [],
  } as unknown as CellData
}

/** `count` concepts, each named by a word no other test has compiled. */
function glossary(prefix: string, count: number): Concept[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}${i}`,
    sourceTerm: `${prefix}word${i}`,
    renderings: [{ rendering: `${prefix}mot${i}`, status: "preferred" }],
    status: "active",
    createdAt: "2026-11-19T00:00:00.000Z",
  }))
}

describe("useHealth — background rule pass", () => {
  it("checks the top of the file in render, the rest in the background, and ends with the full result", async () => {
    // 120 cells, each mentioning a term of its own and missing its rendering:
    // one infraction per cell, and one term pattern to compile per cell.
    const concepts = glossary("bg", 120)
    const rules = compileConceptsToRules(concepts)
    const cells = concepts.map((c, i) => cell(`c${i}`, `the ${c.sourceTerm} here`, "une traduction"))
    const fileCells = new Map([["f", cells]])

    const before = conceptPatternsCompiled()
    const { result } = renderHook(() => useHealth(fileCells, rules))

    // Render compiled a bounded number of term patterns, not 120 …
    const compiledInRender = conceptPatternsCompiled() - before
    expect(compiledInRender).toBeGreaterThan(0)
    expect(compiledInRender).toBeLessThan(40)
    // … so the first result is partial, says so, and starts at the top.
    const first = result.current
    expect(first.infractionsPending).toBeGreaterThan(0)
    expect(first.infractions.size + (first.infractionsPending ?? 0)).toBe(120)
    expect(first.infractions.has("c0")).toBe(true)
    expect(first.infractions.has("c119")).toBe(false)

    // The background finishes and publishes the same map an eager pass gives.
    await waitFor(() => expect(result.current.infractionsPending ?? 0).toBe(0))
    expect(result.current.infractions).toEqual(checkRules(fileCells, rules))
    expect(result.current.infractions.size).toBe(120)
  })

  it("is synchronous once the patterns are compiled, and for a file under the budget", () => {
    // Same shape, patterns already compiled by a first hook: nothing to wait for.
    const concepts = glossary("warm", 80)
    const rules = compileConceptsToRules(concepts)
    const cells = concepts.map((c, i) => cell(`c${i}`, `the ${c.sourceTerm} here`, "une traduction"))
    const fileCells = new Map([["f", cells]])
    checkRules(fileCells, rules)
    const warm = renderHook(() => useHealth(fileCells, rules))
    expect(warm.result.current.infractionsPending).toBeUndefined()
    expect(warm.result.current.infractions.size).toBe(80)

    // A few terms never seen before: under the budget, so still one pass.
    const few = glossary("few", 10)
    const fewRules = compileConceptsToRules(few)
    const fewCells = new Map([["f", few.map((c, i) => cell(`c${i}`, `the ${c.sourceTerm} here`, "une traduction"))]])
    const small = renderHook(() => useHealth(fewCells, fewRules))
    expect(small.result.current.infractionsPending).toBeUndefined()
    expect(small.result.current.infractions.size).toBe(10)
  })

  it("an edit while the background is running is not lost, and stale results are not served", async () => {
    const concepts = glossary("edit", 120)
    const rules = compileConceptsToRules(concepts)
    const cells = concepts.map((c, i) => cell(`c${i}`, `the ${c.sourceTerm} here`, "une traduction"))
    let fileCells = new Map([["f", cells]])
    const { result, rerender } = renderHook(() => useHealth(fileCells, rules))
    expect(result.current.infractionsPending).toBeGreaterThan(0)

    // The last cell (still pending) gets its rendering; the first one changes
    // to a text that mentions no term at all.
    const edited = cells.slice()
    edited[119] = cell("c119", cells[119].original, `une ${concepts[119].renderings[0].rendering}`)
    edited[0] = cell("c0", "nothing to see", "rien")
    fileCells = new Map([["f", edited]])
    rerender()

    await waitFor(() => expect(result.current.infractionsPending ?? 0).toBe(0))
    expect(result.current.infractions).toEqual(checkRules(fileCells, rules))
    expect(result.current.infractions.has("c119")).toBe(false)
    expect(result.current.infractions.has("c0")).toBe(false)
    expect(result.current.infractions.size).toBe(118)
  })
})
