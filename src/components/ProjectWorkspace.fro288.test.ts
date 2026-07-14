/**
 * AQU-288: Batch-validate and focus-lock renewal unit tests.
 *
 * These tests cover the pure-logic parts of the batch-validate wiring:
 *   1. Only cells in the active file with a targetEventId are included.
 *   2. Cells without a targetEventId (never committed) are excluded.
 *   3. The role guard prevents enqueue when the role is below REVIEWER (300).
 *   4. When the role is null/undefined (unknown), canPerform returns true (fail-open).
 *
 * The focus-lock renewal and takeover tests live in useFocusLock.test.tsx
 * (AQU-288 additions at the bottom of that file).
 */

import { describe, it, expect } from "vitest"
import { canPerform } from "@/lib/sync/role-policy"
import { isBulkValidationEligible } from "@/lib/review/review-eligibility"

// ---------------------------------------------------------------------------
// Helper that mirrors the batch-validate filter logic in ProjectWorkspace.tsx
// so we can test it without rendering the full component.
// ---------------------------------------------------------------------------
interface Cell {
  id: string
  fileId: string
  translated: string
  targetEventId?: string | null
  aiDrafted?: boolean
}

function filterValidatableCells(cells: Cell[], activeFileId: string): Cell[] {
  return cells.filter((c) => c.fileId === activeFileId && isBulkValidationEligible(c))
}

describe("AQU-288: batch-validate cell filter", () => {
  const FILE_A = "file-a"
  const FILE_B = "file-b"

  const cells: Cell[] = [
    { id: "c1", fileId: FILE_A, translated: "human", targetEventId: "evt-1" },
    { id: "c2", fileId: FILE_A, translated: "edited", targetEventId: "evt-2", aiDrafted: false },
    { id: "c3", fileId: FILE_A, translated: "", targetEventId: null },
    { id: "c4", fileId: FILE_A, translated: "" },
    { id: "c5", fileId: FILE_B, translated: "human", targetEventId: "evt-5" },
    { id: "c6", fileId: FILE_A, translated: "untouched AI", targetEventId: "evt-6", aiDrafted: true },
  ]

  it("includes only cells in the active file that have a targetEventId", () => {
    const result = filterValidatableCells(cells, FILE_A)
    expect(result.map((c) => c.id)).toEqual(["c1", "c2"])
  })

  it("returns empty when all cells in the active file are uncommitted", () => {
    const uncommitted: Cell[] = [
      { id: "x1", fileId: FILE_A, translated: "", targetEventId: null },
      { id: "x2", fileId: FILE_A, translated: "" },
    ]
    expect(filterValidatableCells(uncommitted, FILE_A)).toHaveLength(0)
  })

  it("excludes cells from other files even when they have a targetEventId", () => {
    const result = filterValidatableCells(cells, FILE_A)
    expect(result.every((c) => c.fileId === FILE_A)).toBe(true)
    expect(result.find((c) => c.id === "c5")).toBeUndefined()
  })

  it("excludes untouched AI drafts until a human reviews them", () => {
    const result = filterValidatableCells(cells, FILE_A)
    expect(result.find((c) => c.id === "c6")).toBeUndefined()
  })
})

describe("AQU-288: batch-validate role guard (canPerform)", () => {
  // cell.validate requires REVIEWER (300) per role-policy.ts.

  it("allows REVIEWER (300) to validate", () => {
    expect(canPerform("cell.validate", 300)).toBe(true)
  })

  it("allows CONTRIBUTOR (400) and above to validate", () => {
    expect(canPerform("cell.validate", 400)).toBe(true)
    expect(canPerform("cell.validate", 500)).toBe(true)
    expect(canPerform("cell.validate", 700)).toBe(true)
  })

  it("blocks COMMENTER (200) from validating", () => {
    expect(canPerform("cell.validate", 200)).toBe(false)
  })

  it("blocks VIEWER (100) from validating", () => {
    expect(canPerform("cell.validate", 100)).toBe(false)
  })

  it("is fail-open when role is null (unknown role — let server decide)", () => {
    expect(canPerform("cell.validate", null)).toBe(true)
  })

  it("is fail-open when role is undefined", () => {
    expect(canPerform("cell.validate", undefined)).toBe(true)
  })
})
