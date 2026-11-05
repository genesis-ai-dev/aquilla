// AQU-2308: hand-set milestones in the navigator derivation.
//
// The regression guard for the thing that could not be done before — naming
// lines 50–70 "The storm" WITHOUT also having to name whatever follows line
// 70 — plus the rules that keep a hand-set division from disturbing anything
// else: a division the file supplied is never moved, renamed, re-counted or
// straddled, and the AI-section overlay never re-cuts a hand-set milestone.

import { describe, expect, it } from "vitest"
import {
  deriveMilestoneNavigation,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import { FALLBACK_MILESTONE_SIZE } from "./import/milestones"
import type { FileMilestone } from "../../db/shared/file-milestones"
import type { ImportMilestone } from "../../shared/import-contract"
import { SECTION_BOUNDARY_LEVEL } from "./import/ai-sections"
import { USER_MILESTONE_BADGE } from "./editor/user-milestone-spans"

const record = (
  id: string,
  startCellId: string,
  endCellId: string,
  name: string,
): FileMilestone => ({ id, name, startCellId, endCellId })

/** A plain-text file of `count` unheaded lines — the navigator invents "Part N". */
function plainTextFile(count: number): MilestoneNavigationCell[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    original: `line ${index + 1}`,
  }))
}

function persisted(id: string, milestone: ImportMilestone): MilestoneNavigationCell {
  return { id, original: id, metadata: { aquillaImport: { milestone } } }
}

const chapter = (book: string, n: number): ImportMilestone => ({
  key: `scripture:${book}:${n}`, kind: "chapter", label: `Mark ${n}`, shortLabel: String(n),
})

function labels(cells: MilestoneNavigationCell[], userMilestones: FileMilestone[]) {
  return deriveMilestoneNavigation(cells, { userMilestones, aiSections: false })
}

describe("deriveMilestoneNavigation with hand-set milestones", () => {
  it("names a range inside app-made parts and leaves the rest in parts", () => {
    // 120 lines with no headings: the app invents Part 1 (c0–c49),
    // Part 2 (c50–c99), Part 3 (c100–c119). "The storm" covers c49–c69 —
    // deliberately straddling the Part 1 / Part 2 seam, because that boundary
    // is one the APP invented and crossing it is allowed.
    const result = labels(plainTextFile(120), [record("ms", "c49", "c69", "The storm")])

    expect(result.orderedMilestones.map((group) => group.milestone.label))
      .toEqual(["Part 1", "The storm", "Part 2", "Part 3"])

    const [first, storm, second, third] = result.orderedMilestones
    // The lines before and after it are still in app-made parts, and neither
    // had to be named.
    expect(first.cellIds).toHaveLength(49)
    expect(storm.cellIds).toHaveLength(21)
    expect(storm.cellIds[0]).toBe("c49")
    expect(storm.cellIds.at(-1)).toBe("c69")
    expect(second.cellIds[0]).toBe("c70")
    expect(second.cellIds).toHaveLength(30)
    expect(third.cellIds[0]).toBe("c100")
    // Every cell still belongs to exactly one division.
    const covered = result.orderedMilestones.flatMap((group) => [...group.cellIds])
    expect(covered).toHaveLength(120)
    expect(new Set(covered).size).toBe(120)
  })

  it("renumbers the surviving parts instead of leaving a gap or a repeat", () => {
    // A milestone strictly INSIDE one part splits it. Both leftovers must be
    // listed separately and numbered over themselves, or the navigator shows
    // one entry that silently spans the milestone.
    const result = labels(plainTextFile(FALLBACK_MILESTONE_SIZE), [
      record("ms", "c20", "c29", "The storm"),
    ])

    expect(result.orderedMilestones.map((group) => group.milestone.label))
      .toEqual(["Part 1", "The storm", "Part 2"])
    // The two parts are badged over themselves; the hand-set row carries the
    // non-numeric marker so a numeric search cannot land on it.
    expect(result.orderedMilestones.map((group) => group.milestone.shortLabel))
      .toEqual(["1", USER_MILESTONE_BADGE, "2"])
    expect(result.orderedMilestones[0].cellIds).toHaveLength(20)
    expect(result.orderedMilestones[2].cellIds).toHaveLength(20)
    // The two part entries are genuinely distinct rows.
    expect(result.orderedMilestones[0].milestone.key)
      .not.toBe(result.orderedMilestones[2].milestone.key)
  })

  it("nests inside a chapter without moving, renaming or re-counting it", () => {
    const cells = [
      persisted("m3-1", chapter("MRK", 3)),
      persisted("m4-35", chapter("MRK", 4)),
      persisted("m4-38", chapter("MRK", 4)),
      persisted("m4-41", chapter("MRK", 4)),
      persisted("m5-1", chapter("MRK", 5)),
    ]
    const result = labels(cells, [
      record("ms", "m4-35", "m4-41", "The calming of the storm"),
    ])

    // Mark 4 stays ONE top-level entry holding exactly its own cells.
    expect(result.orderedMilestones.map((group) => group.milestone.key)).toEqual([
      "scripture:MRK:3",
      "scripture:MRK:4",
      "scripture:MRK:5",
    ])
    const mark4 = result.orderedMilestones[1]
    expect(mark4.milestone.label).toBe("Mark 4")
    expect(mark4.cellIds).toEqual(["m4-35", "m4-38", "m4-41"])

    // …and the milestone is a named sub-entry under it.
    expect(mark4.named).toEqual([{
      key: "user:ms",
      label: "The calming of the storm",
      shortLabel: USER_MILESTONE_BADGE,
      firstCellId: "m4-35",
      firstIndex: 1,
      cellIds: ["m4-35", "m4-38", "m4-41"],
    }])
    // Mark 3 and Mark 5 are untouched.
    expect(result.orderedMilestones[0].named).toBeUndefined()
    expect(result.orderedMilestones[2].named).toBeUndefined()
  })

  it("ignores a record that crosses a chapter boundary", () => {
    const cells = [
      persisted("m4-38", chapter("MRK", 4)),
      persisted("m4-41", chapter("MRK", 4)),
      persisted("m5-1", chapter("MRK", 5)),
      persisted("m5-2", chapter("MRK", 5)),
    ]
    const result = labels(cells, [record("ms", "m4-38", "m5-2", "Crosses")])

    expect(result.orderedMilestones.map((group) => group.milestone.key))
      .toEqual(["scripture:MRK:4", "scripture:MRK:5"])
    expect(result.orderedMilestones.every((group) => group.named === undefined)).toBe(true)
  })

  it("keeps the first of two overlapping records and skips the second", () => {
    const result = labels(plainTextFile(FALLBACK_MILESTONE_SIZE * 2), [
      record("second", "c59", "c74", "Overlaps"),
      record("first", "c49", "c69", "The storm"),
    ])

    const names = result.orderedMilestones.map((group) => group.milestone.label)
    expect(names).toContain("The storm")
    expect(names).not.toContain("Overlaps")
  })

  it("changes nothing about any cell's own identity outside the range", () => {
    const cells = plainTextFile(120)
    const before = deriveMilestoneNavigation(cells, { aiSections: false })
    const after = labels(cells, [record("ms", "c49", "c69", "The storm")])

    for (const cell of cells) {
      const index = Number(cell.id.slice(1))
      if (index >= 49 && index <= 69) continue
      // Outside the milestone the division a cell belongs to is still an
      // app-made part, with the same cells around it.
      expect(after.milestoneByCellId.get(cell.id)?.kind)
        .toBe(before.milestoneByCellId.get(cell.id)?.kind)
    }
    // And every cell in the range now reads as the hand-set division.
    for (let index = 49; index <= 69; index += 1) {
      expect(after.milestoneByCellId.get(`c${index}`)).toMatchObject({
        key: "user:ms",
        kind: "user",
        label: "The storm",
      })
    }
  })

  it("leaves navigation exactly as it was when the file has no hand-set milestones", () => {
    const cells = plainTextFile(120)
    expect(deriveMilestoneNavigation(cells, { userMilestones: [], aiSections: false }))
      .toEqual(deriveMilestoneNavigation(cells, { aiSections: false }))
  })

  it("never lets the AI-section overlay re-cut a hand-set milestone", () => {
    // Every seam is a strong section break, so with the overlay ON the whole
    // file would normally be re-cut into AI sections.
    const cells = plainTextFile(40)
    const boundaries = () => ({ level: SECTION_BOUNDARY_LEVEL } as const)

    const withoutUser = deriveMilestoneNavigation(cells, { boundaries, aiSections: true })
    expect(withoutUser.orderedMilestones.some((g) => g.milestone.kind === "ai-section"))
      .toBe(true)

    const withUser = deriveMilestoneNavigation(cells, {
      boundaries,
      aiSections: true,
      userMilestones: [record("ms", "c10", "c19", "The storm")],
    })
    // The hand-set milestone is exactly as set…
    const storm = withUser.orderedMilestones.find((g) => g.milestone.key === "user:ms")
    expect(storm?.cellIds).toEqual(
      Array.from({ length: 10 }, (_, i) => `c${i + 10}`),
    )
    // …and no AI section has taken any of its cells.
    for (let index = 10; index <= 19; index += 1) {
      expect(withUser.milestoneByCellId.get(`c${index}`)?.kind).toBe("user")
    }
  })
})
