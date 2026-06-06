import { describe, it, expect } from "vitest"
import { buildCellData } from "./useCells"
import type { CellAuditStats } from "./useCellsAuditStats"

// Minimal CellRow stub
function makeTarget(value: string, validated = false) {
  return { value, validated, rowId: "r1", cellId: "c1", fileId: "f1", projectId: "p1", versionTag: 1 } as any
}
function makeSource(value: string) {
  return makeTarget(value, false)
}
function makeStats(validators: string[]): CellAuditStats {
  return { activeValidators: validators, totalEdits: 0, lastEditAt: 0 } as any
}

const FILE_ID = "f1"
const REQUIRED = 2

describe("classifyValidators via buildCellData — 5-state validation", () => {
  it('returns "empty" when no translation', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget(""), FILE_ID, "alice", REQUIRED, undefined)
    expect(cell.validationStatus).toBe("empty")
  })

  it('returns "none" when translated but no validators', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", REQUIRED, makeStats([]))
    expect(cell.validationStatus).toBe("none")
  })

  it('returns "self" when current user has validated but threshold not met', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", REQUIRED, makeStats(["alice"]))
    expect(cell.validationStatus).toBe("self")
  })

  it('returns "others" when other users validated but not current user and threshold not met', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", REQUIRED, makeStats(["bob"]))
    expect(cell.validationStatus).toBe("others")
  })

  it('returns "full-self" when threshold met and current user is one of the validators', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", REQUIRED, makeStats(["alice", "bob"]))
    expect(cell.validationStatus).toBe("full-self")
  })

  it('returns "full-others" when threshold met but current user has NOT validated', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", REQUIRED, makeStats(["bob", "carol"]))
    expect(cell.validationStatus).toBe("full-others")
  })

  it('returns "full-others" when no stats but target.validated = true (legacy path)', () => {
    const cell = buildCellData("c1", makeSource("Hello"), makeTarget("Hola", true), FILE_ID, "alice", REQUIRED, undefined)
    expect(cell.validationStatus).toBe("full-others")
  })
})
