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
  cuesForFile,
  expectedCounts,
  linksForFile,
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
  const byName = (name: string) => units.find((u) => u.fileName === name)!

  it("expects audio of the episodes with a cue sheet, and only those", () => {
    // The per-file gate inside ONE project: an episode nobody is dubbing must
    // not be short by its whole cue count because its neighbour was recorded.
    const sheeted = VTT_FILES.filter((f) => f.cues !== undefined).map((f) => `plan-1278-${f.id}`)
    expect([...audioFiles].sort()).toEqual(sheeted.sort())
    const noSheet = byName("Season 1 · Episode 2")
    expect(planUnitShortfall(noSheet, audioFiles.has(noSheet.fileId)).toRecord).toBe(0)
  })

  it("counts a fully dubbed episode's takes against its cues, not its subtitles", () => {
    // 120 subtitle cells, 100 cues, 100 takes. Against the subtitles this reads
    // twenty takes short and never leaves In progress.
    const e1 = byName("Season 1 · Episode 1")
    expect(e1.audioTotalCount).toBe(100)
    expect(planUnitShortfall(e1, true).toRecord).toBe(0)
    const { audioTotalCount: _drop, ...asSubtitles } = e1
    expect(planUnitShortfall(asSubtitles, true).toRecord).toBe(20)
  })

  it("makes the mostly-dubbed episode nearly complete by audio alone", () => {
    const e4 = byName("Season 1 · Episode 4")
    const s = planUnitShortfall(e4, true)
    expect(s.toValidate).toBe(0)
    expect(s.toRecord).toBe(5)
    expect(s.worst).toBeLessThanOrEqual(planNearlyCompleteThreshold(e4.totalCount))
  })

  it("keeps a finished-text episode with an empty cue sheet out of Nearly complete", () => {
    // The sheet is the declaration that dubbing is planned. Without it this
    // episode reads "Nothing left" and then moves BACKWARDS on the first take.
    const e = byName("Season 2 · Episode 2")
    expect(e.audioCount).toBe(0)
    expect(e.audioTotalCount).toBe(120)
    expect(planUnitShortfall(e, audioFiles.has(e.fileId)).toRecord).toBe(120)
    const { audioTotalCount: _drop, ...noSheet } = e
    expect(planUnitStatus(noSheet, NOW, new Set())).toBe("nearly_complete")
  })

  it("links every subtitle cell but the last two, to a cue that exists", () => {
    // The board ignores these; the editor does not, and a fixture nobody can
    // open in the editor is not the real shape.
    for (const f of VTT_FILES) {
      const links = linksForFile(f)
      if (f.cues === undefined) {
        expect(links).toEqual([])
        continue
      }
      const cells = new Set(cellsForFile(f).map((c) => c.cellId))
      const cues = new Set(cuesForFile(f).map((c) => c.cellId))
      expect(links).toHaveLength(f.cells - 2)
      for (const l of links) {
        expect(cells.has(l.from)).toBe(true)
        expect(cues.has(l.to)).toBe(true)
      }
    }
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
