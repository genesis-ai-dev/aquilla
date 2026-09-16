/**
 * The file-grain fixtures claim a group per file. This runs the shipping
 * `planUnitStatus` over both tables and checks that each claim holds — the
 * same guard `plan-fixture.test.ts` puts on the Bible fixture.
 */
import { describe, expect, it } from "vitest"
import {
  DOCS_ASSIGNMENTS,
  DOCS_FILES,
  VTT_ASSIGNMENTS,
  VTT_FILES,
  assignedCells,
  cellsForFile,
  expectedCounts,
  type FixtureFile,
} from "./plan-fixture-files"
import {
  audioFileIds,
  planNearlyCompleteThreshold,
  planUnitShortfall,
  planUnitStatus,
  type PlanUnit,
} from "./plan-status"

const DAY = 86_400_000
const NOW = Date.parse("2026-09-16T12:00:00Z")

function unitFor(f: FixtureFile): PlanUnit {
  return {
    fileId: `plan-1278-${f.id}`,
    fileName: f.name,
    sectionKey: "",
    ...expectedCounts(f),
    lastEditAt: NOW - DAY,
    targetDate: f.targetDateInDays === undefined
      ? null
      : new Date(NOW + f.targetDateInDays * DAY).toISOString().slice(0, 10),
    doneAt: f.doneDaysAgo === undefined ? null : NOW - f.doneDaysAgo * DAY,
    doneBy: f.doneDaysAgo === undefined ? null : "dev",
  }
}

describe.each([
  ["subtitles", VTT_FILES, VTT_ASSIGNMENTS],
  ["documents", DOCS_FILES, DOCS_ASSIGNMENTS],
] as const)("the %s fixture", (_name, files, assignments) => {
  const units = files.map(unitFor)
  const audioFiles = audioFileIds(units)

  it.each(files.map((f) => [f.id, f] as const))(
    "%s lands in the group it claims",
    (_id, f) => {
      const u = units.find((x) => x.fileName === f.name)!
      expect(planUnitStatus(u, NOW, audioFiles)).toBe(f.expect)
    },
  )

  it("covers every status in the vocabulary", () => {
    const seen = new Set(units.map((u) => planUnitStatus(u, NOW, audioFiles)))
    expect([...seen].sort()).toEqual(
      ["done", "in_progress", "nearly_complete", "not_started", "overdue", "soon"],
    )
  })

  it("assigns no cell twice and no cell that does not exist", () => {
    const existing = new Set(files.flatMap((f) => cellsForFile(f).map((c) => c.cellId)))
    const seen = new Set<string>()
    for (const a of assignments) {
      for (const cellId of assignedCells(a, files)) {
        expect(existing.has(cellId)).toBe(true)
        expect(seen.has(cellId)).toBe(false)
        seen.add(cellId)
      }
    }
  })
})

describe("what only the subtitle fixture can prove", () => {
  const units = VTT_FILES.map(unitFor)
  const audioFiles = audioFileIds(units)

  it("expects audio of the dubbed episodes only", () => {
    // The per-file gate inside ONE project: an undubbed episode must not be
    // short by its whole cue count because its neighbour was recorded.
    const dubbed = VTT_FILES.filter((f) => f.dubbed).map((f) => `plan-1278-${f.id}`)
    expect([...audioFiles].sort()).toEqual(dubbed.sort())
    const undubbed = units.find((u) => u.fileName === "Season 1 · Episode 2")!
    expect(planUnitShortfall(undubbed, audioFiles.has(undubbed.fileId)).toRecord).toBe(0)
  })

  it("makes the dubbed-but-unrecorded episode nearly complete by audio alone", () => {
    const e4 = units.find((u) => u.fileName === "Season 1 · Episode 4")!
    const s = planUnitShortfall(e4, true)
    expect(s.toValidate).toBe(0)
    expect(s.toRecord).toBe(5)
    expect(s.worst).toBeLessThanOrEqual(planNearlyCompleteThreshold(e4.totalCount))
  })
})

describe("what only the document fixture can prove", () => {
  it("lets the seven-cell floor call a five-cell README nearly complete at 60%", () => {
    // Deliberately kept: the tiny-file edge Sam has not ruled on. If the rule
    // changes — a minimum cell count, a floor that scales — this is the test
    // that says so, and the fixture entry's `expect` moves with it.
    const readme = DOCS_FILES.find((f) => f.id === "readme")!
    const u = unitFor(readme)
    expect(u.filledCount / u.totalCount).toBeCloseTo(0.6)
    expect(planNearlyCompleteThreshold(u.totalCount)).toBe(7)
    expect(planUnitStatus(u, NOW, new Set())).toBe("nearly_complete")
  })
})
