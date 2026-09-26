import { describe, it, expect } from "vitest"
import { buildCellData } from "./useCells"
import { cellHealth } from "@/lib/health/decay-engine"
import { ribbonStage } from "@/lib/health/ribbon-inputs"
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

describe("buildCellData decodes entity-laden plain values (AQU-674)", () => {
  it("decodes literal HTML entities in migrated target/source value at the read boundary", () => {
    // Existing migrated Algerian data carries literal `&nbsp;` in `cells.value`
    // (pre-fix migration stripped tags without decoding). The read boundary
    // must decode so the plain-text render surface shows clean spacing.
    const cell = buildCellData(
      "c1",
      makeSource("In&nbsp;the&nbsp;beginning"),
      makeTarget("فِي&nbsp;ٱلْبَدْءِ"),
      FILE_ID,
      "alice",
      REQUIRED,
      undefined,
    )
    expect(cell.translated).toBe("فِي ٱلْبَدْءِ")
    expect(cell.original).toBe("In the beginning")
    expect(cell.translated).not.toMatch(/&[a-z]+;/i)
  })

  it("does not over-decode a legitimate literal ampersand", () => {
    const cell = buildCellData("c1", makeSource("R&D"), makeTarget("Moses & Aaron"), FILE_ID, "alice", REQUIRED, undefined)
    expect(cell.translated).toBe("Moses & Aaron")
    expect(cell.original).toBe("R&D")
  })
})

// ---------------------------------------------------------------------------
// AQU-1364: health stayed at 100% after a cell was unvalidated.
//
// `cell.unvalidate` refetches the cell's AUDIT STATS but not its projected
// ROW (`isStatsDerivableKind` excludes the validation pair), so immediately
// after an unvalidate the row still carries `validated: true` /
// `endorsementCount: 1` while the stats correctly report zero validators.
// `buildCellData` preferred the stale row, so the cell kept reading
// "validated" with a full endorsement count and its health bar stayed green.
// ---------------------------------------------------------------------------
describe("AQU-1364 — audit stats outrank the stale row after an unvalidate", () => {
  const ONE = 1
  /** The row as it sits post-unvalidate: not yet refetched, so still stale. */
  const staleValidatedRow = () =>
    ({ ...makeTarget("Hola", true), endorsementCount: 1 }) as any

  it("drops endorsementCount to the audit's validator count, so health falls with it", () => {
    const cell = buildCellData(
      "c1", makeSource("Hello"), staleValidatedRow(), FILE_ID, "alice", ONE, makeStats([]),
    )
    expect(cell.endorsementCount).toBe(0)
    expect(cellHealth(cell.endorsementCount ?? 0, ONE)).toBe(0)
  })

  it("reports the cell as unvalidated, so the ribbon does not pin it to the validated 100", () => {
    const cell = buildCellData(
      "c1", makeSource("Hello"), staleValidatedRow(), FILE_ID, "alice", ONE, makeStats([]),
    )
    expect(cell.status).toBe("unvalidated")
    expect(ribbonStage(cell)).toBe("automatic")
    expect(cell.validationStatus).toBe("none")
  })

  it("matches an untouched neighbour computed from the same example set (AC 1)", () => {
    const unvalidated = buildCellData(
      "c1", makeSource("Hello"), staleValidatedRow(), FILE_ID, "alice", ONE, makeStats([]),
    )
    const neighbour = buildCellData(
      "c2", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", ONE, makeStats([]),
    )
    expect(cellHealth(unvalidated.endorsementCount ?? 0, ONE))
      .toBe(cellHealth(neighbour.endorsementCount ?? 0, ONE))
    expect(unvalidated.status).toBe(neighbour.status)
  })

  it("survives the reload: the refetched row agrees with the pre-reload value (AC 2)", () => {
    const beforeReload = buildCellData(
      "c1", makeSource("Hello"), staleValidatedRow(), FILE_ID, "alice", ONE, makeStats([]),
    )
    // After a reload the projection has caught up: the row is clean.
    const afterReload = buildCellData(
      "c1", makeSource("Hello"), makeTarget("Hola", false), FILE_ID, "alice", ONE, makeStats([]),
    )
    expect(beforeReload.endorsementCount).toBe(afterReload.endorsementCount)
    expect(beforeReload.status).toBe(afterReload.status)
    expect(cellHealth(beforeReload.endorsementCount ?? 0, ONE))
      .toBe(cellHealth(afterReload.endorsementCount ?? 0, ONE))
  })

  it("still takes a validated cell to full health (AC 3 — no regression)", () => {
    const cell = buildCellData(
      "c1", makeSource("Hello"), makeTarget("Hola", true), FILE_ID, "alice", ONE, makeStats(["alice"]),
    )
    expect(cell.endorsementCount).toBe(1)
    expect(cell.status).toBe("validated")
    expect(cellHealth(cell.endorsementCount ?? 0, ONE)).toBe(100)
  })

  it("leaves a never-validated cell exactly as it was (AC 4 — no regression)", () => {
    const cell = buildCellData(
      "c1", makeSource("Hello"), makeTarget("Hola"), FILE_ID, "alice", ONE, makeStats([]),
    )
    expect(cell.endorsementCount).toBe(0)
    expect(cell.status).toBe("unvalidated")
    expect(cellHealth(cell.endorsementCount ?? 0, ONE)).toBe(0)
  })

  it("keeps reading the row when no audit stats have loaded for the cell", () => {
    // No stats → the denormalized columns are the only signal there is.
    const cell = buildCellData(
      "c1", makeSource("Hello"), staleValidatedRow(), FILE_ID, "alice", ONE, undefined,
    )
    expect(cell.endorsementCount).toBe(1)
    expect(cell.status).toBe("validated")
  })

  it("counts a partial endorsement from the audit against a higher threshold", () => {
    // Threshold 2, one validator left after the other unvalidated: the cell is
    // no longer validated but still carries the one endorsement it has.
    const cell = buildCellData(
      "c1", makeSource("Hello"),
      { ...makeTarget("Hola", true), endorsementCount: 2 } as any,
      FILE_ID, "alice", 2, makeStats(["bob"]),
    )
    expect(cell.endorsementCount).toBe(1)
    expect(cell.status).toBe("unvalidated")
    expect(cellHealth(cell.endorsementCount ?? 0, 2)).toBe(50)
  })
})
