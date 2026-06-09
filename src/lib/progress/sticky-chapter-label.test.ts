/**
 * FRO-250: sticky chapter indicator label derivation.
 *
 * The EditorTable derives a per-row section label array (sectionByIndex) so
 * the sticky header can show the current chapter as you scroll. These tests
 * encode the derivation rules:
 *
 *  - The label for a row is the "BOOK CH" prefix of its first globalReference.
 *  - When a row has no reference, it inherits the last non-empty label (carry-
 *    forward so paratext rows inside a chapter don't reset the indicator).
 *  - A file with no section-tagged cells produces an empty string for every row
 *    so the sticky header stays hidden.
 */

import { describe, it, expect } from "vitest"

type DisplayCell = {
  globalReferences?: string[]
  section?: string
}

/**
 * Mirrors the sectionByIndex logic in EditorTable exactly.
 * Keep this in sync with the implementation if that logic changes.
 */
function buildSectionByIndex(displayCells: DisplayCell[]): string[] {
  const out: string[] = []
  let lastLabel = ""
  for (const cell of displayCells) {
    const firstRef = cell.globalReferences?.find((r) => r && r.trim().length > 0)
    if (firstRef) {
      const colon = firstRef.indexOf(":")
      lastLabel = (colon >= 0 ? firstRef.slice(0, colon) : firstRef).trim()
    } else if (cell.section?.trim()) {
      lastLabel = cell.section.trim()
    }
    out.push(lastLabel)
  }
  return out
}

describe("sticky chapter label derivation (FRO-250)", () => {
  it("assigns the chapter label to every row in that chapter", () => {
    const cells: DisplayCell[] = [
      { globalReferences: ["LUK 1:1"] },
      { globalReferences: ["LUK 1:2"] },
      { globalReferences: ["LUK 1:3"] },
    ]
    const labels = buildSectionByIndex(cells)
    expect(labels).toEqual(["LUK 1", "LUK 1", "LUK 1"])
  })

  it("changes the label when a new chapter starts", () => {
    const cells: DisplayCell[] = [
      { globalReferences: ["LUK 1:1"] },
      { globalReferences: ["LUK 2:1"] },
      { globalReferences: ["LUK 3:1"] },
    ]
    const labels = buildSectionByIndex(cells)
    expect(labels).toEqual(["LUK 1", "LUK 2", "LUK 3"])
  })

  it("carry-forwards the label across paratext rows (no reference)", () => {
    const cells: DisplayCell[] = [
      { globalReferences: ["GEN 1:1"] },
      {},
      {},
      { globalReferences: ["GEN 1:2"] },
    ]
    const labels = buildSectionByIndex(cells)
    expect(labels).toEqual(["GEN 1", "GEN 1", "GEN 1", "GEN 1"])
  })

  it("returns empty strings for files with no section structure", () => {
    const cells: DisplayCell[] = [{}, {}, {}]
    const labels = buildSectionByIndex(cells)
    expect(labels).toEqual(["", "", ""])
  })

  it("uses cell.section when globalReferences is absent", () => {
    const cells: DisplayCell[] = [
      { section: "Introduction" },
      { section: "Introduction" },
      { section: "Chapter 1" },
    ]
    const labels = buildSectionByIndex(cells)
    expect(labels).toEqual(["Introduction", "Introduction", "Chapter 1"])
  })
})
