// AQU-2186: "Rename section…" and "Remove section" — the derivation half.
//
// Both gestures are the SAME event AQU-2185 introduced: rename is another
// `source.cell.milestone.set` carrying a new label, remove is one carrying
// `null`. Neither has a projection of its own, so what has to be pinned here
// is that the derivation turns those two column states into the divisions the
// ticket promises:
//
//   * a renamed section keeps its identity (the key, hence the navigator
//     selection and the Split-into-milestones page) and changes only its name;
//   * removing the only section restores EXACTLY the app-made divisions the
//     file showed before it was set — byte-for-byte the same list, which is the
//     acceptance criterion a hand-written expectation would only approximate;
//   * removing one of two folds its cells into the section above it, and
//     leaves the other alone;
//   * remove-then-start-again on the same cell lands on the new name.
//
// Two sections may share a name, so "which division is this" cannot be read off
// the label. `handSetSectionCellId` is the inverse that answers it, and is what
// the row uses to decide whose menu offers these two entries at all.

import { describe, expect, it } from "vitest"
import {
  deriveMilestoneNavigation,
  handSetSectionCellId,
  type MilestoneNavigationCell,
} from "./milestone-navigation"
import { FALLBACK_MILESTONE_SIZE } from "./import/milestones"

function plainFile(count: number, marks: Record<number, string> = {}): MilestoneNavigationCell[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `c${index}`,
    original: `line ${index}`,
    ...(marks[index] === undefined ? {} : { milestoneLabel: marks[index] }),
  }))
}

/** The navigator's entries as (label, kind, first cell, cell count) tuples. */
function entries(cells: readonly MilestoneNavigationCell[]) {
  return deriveMilestoneNavigation(cells).orderedMilestones.map((group) => ({
    label: group.milestone.label,
    kind: group.milestone.kind,
    firstCellId: group.firstCellId,
    count: group.cellIds.length,
  }))
}

const SIZE = FALLBACK_MILESTONE_SIZE

describe("renaming a hand-set section (AQU-2186)", () => {
  it("changes the name and nothing else about the division", () => {
    const before = deriveMilestoneNavigation(plainFile(120, { 70: "The storm" }))
    const after = deriveMilestoneNavigation(plainFile(120, { 70: "Calming the storm" }))

    const storm = before.orderedMilestones.at(-1)
    const calmed = after.orderedMilestones.at(-1)

    expect(storm?.milestone.label).toBe("The storm")
    expect(calmed?.milestone.label).toBe("Calming the storm")
    // The KEY is unchanged, which is what keeps the navigator's selection and
    // the Split-into-milestones page put across a rename: the division's
    // identity is the marked cell, never its name.
    expect(calmed?.milestone.key).toBe(storm?.milestone.key)
    expect(calmed?.cellIds).toEqual(storm?.cellIds)
    // And the divisions above it are untouched.
    expect(entries(plainFile(120, { 70: "Calming the storm" })).slice(0, 2))
      .toEqual(entries(plainFile(120, { 70: "The storm" })).slice(0, 2))
  })

  it("renames every cell's division, not only the marked one", () => {
    const after = deriveMilestoneNavigation(plainFile(120, { 70: "Calming the storm" }))

    expect(after.milestoneByCellId.get("c70")?.label).toBe("Calming the storm")
    expect(after.milestoneByCellId.get("c119")?.label).toBe("Calming the storm")
  })
})

describe("removing a hand-set section (AQU-2186)", () => {
  it("brings back exactly the divisions the file showed before it was set", () => {
    // The acceptance criterion word for word: a Part N file whose only
    // hand-set section is removed shows Part 1, Part 2, Part 3 again. Compared
    // against the untouched file rather than a hand-written list, so the match
    // is total — labels, kinds, boundaries and counts alike.
    expect(entries(plainFile(120))).toEqual(entries(plainFile(120, {})))
    expect(entries(plainFile(120, {}))).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: SIZE },
      { label: "Part 3", kind: "part", firstCellId: "c100", count: 20 },
    ])

    const marked = plainFile(120, { 70: "The storm" })
    expect(entries(marked)).not.toEqual(entries(plainFile(120)))
    // …and clearing the label is all a removal does to the input.
    const cleared = marked.map(({ milestoneLabel: _label, ...rest }) => rest)
    expect(entries(cleared)).toEqual(entries(plainFile(120)))
  })

  it("folds the removed section's cells into the section above it", () => {
    const both = plainFile(120, { 60: "The storm", 90: "The calm" })
    expect(entries(both)).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: 10 },
      { label: "The storm", kind: "hand-set", firstCellId: "c60", count: 30 },
      { label: "The calm", kind: "hand-set", firstCellId: "c90", count: 30 },
    ])

    // Remove the SECOND: its 30 cells join the first, which now runs c60–c119.
    expect(entries(plainFile(120, { 60: "The storm" }))).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: 10 },
      { label: "The storm", kind: "hand-set", firstCellId: "c60", count: 60 },
    ])
  })

  it("leaves the other section untouched when one of two is removed", () => {
    // Remove the FIRST instead: the app-made divisions reclaim its stretch up
    // to the second marker, and "The calm" is exactly as it was.
    const remaining = entries(plainFile(120, { 90: "The calm" }))

    expect(remaining.at(-1)).toEqual(
      { label: "The calm", kind: "hand-set", firstCellId: "c90", count: 30 },
    )
    expect(remaining.slice(0, -1)).toEqual([
      { label: "Part 1", kind: "part", firstCellId: "c0", count: SIZE },
      { label: "Part 2", kind: "part", firstCellId: "c50", count: 40 },
    ])
  })

  it("lets the same cell start a section again afterwards, under the new name", () => {
    const again = entries(plainFile(120, { 70: "Second try" }))

    expect(again.at(-1)).toEqual(
      { label: "Second try", kind: "hand-set", firstCellId: "c70", count: 50 },
    )
  })
})

describe("handSetSectionCellId (AQU-2186)", () => {
  it("names the cell whose menu may rename or remove the division", () => {
    const derived = deriveMilestoneNavigation(plainFile(120, { 70: "The storm" }))

    const handSet = derived.orderedMilestones.at(-1)!.milestone
    expect(handSetSectionCellId(handSet)).toBe("c70")
  })

  it("is null for every division the app made up or the file supplied", () => {
    const derived = deriveMilestoneNavigation(plainFile(120, { 70: "The storm" }))

    for (const { milestone } of derived.orderedMilestones) {
      if (milestone.kind === "hand-set") continue
      expect(handSetSectionCellId(milestone)).toBeNull()
    }
  })

  it("survives a rename, because the key is the marked cell and not the name", () => {
    const renamed = deriveMilestoneNavigation(plainFile(120, { 70: "Calming the storm" }))

    expect(handSetSectionCellId(renamed.orderedMilestones.at(-1)!.milestone)).toBe("c70")
  })

  it("refuses a 'hand-set' key that carries no cell id", () => {
    // Defensive: the kind alone is not the contract, the key format is. A
    // milestone claiming the kind without the prefix came from something that
    // did not mint it here, and must not be offered a rename entry pointing at
    // the wrong cell.
    expect(handSetSectionCellId({ key: "part:3", kind: "hand-set" })).toBeNull()
    expect(handSetSectionCellId({ key: "handset:", kind: "hand-set" })).toBeNull()
  })
})
