import { describe, expect, it } from "vitest"
import { normalizeMilestoneName, type FileMilestone } from "../../../db/shared/file-milestones"
import type { ImportMilestone } from "../../../shared/import-contract"
import {
  isAppInventedMilestoneKind,
  milestoneRowActions,
  planUserMilestones,
  refusalForUserMilestone,
  USER_MILESTONE_BADGE,
  userMilestoneIdentity,
  userMilestoneIdFromKey,
  userMilestoneKey,
} from "./user-milestone-spans"

const part = (n: number): ImportMilestone => ({
  key: `part:p${n}`, kind: "part", label: `Part ${n}`, shortLabel: String(n),
})
const chapter = (n: number): ImportMilestone => ({
  key: `scripture:MRK:${n}`, kind: "chapter", label: `Mark ${n}`, shortLabel: String(n),
})
const bucket = (ms: number): ImportMilestone => ({
  key: `time:${ms}`, kind: "time-range", label: `${ms}`, shortLabel: `${ms}`,
})

const record = (
  id: string,
  startCellId: string,
  endCellId: string,
  name = id,
): FileMilestone => ({ id, name, startCellId, endCellId })

/** `n` cells, `c0`…`c{n-1}`. */
const order = (n: number): string[] => Array.from({ length: n }, (_, i) => `c${i}`)

describe("isAppInventedMilestoneKind", () => {
  it.each([
    ["part", true],
    ["time-range", true],
    ["ai-section", true],
    ["chapter", false],
    ["chapter-range", false],
    ["preface", false],
    ["section", false],
    ["slide", false],
    ["story", false],
    ["group", false],
    ["user", false],
    [undefined, false],
  ])("%o -> %o", (kind, expected) => {
    expect(isAppInventedMilestoneKind(kind as never)).toBe(expected)
  })
})

describe("userMilestoneIdentity", () => {
  it("shows the name exactly as typed, with a non-numeric badge", () => {
    expect(userMilestoneIdentity(record("ms-1", "c0", "c2", "  The   storm"), 3)).toEqual({
      key: "user:ms-1",
      kind: "user",
      label: "  The   storm",
      shortLabel: USER_MILESTONE_BADGE,
    })
  })

  it("never badges a number, so a numeric search cannot collide with Part N", () => {
    const badge = userMilestoneIdentity(record("ms-1", "c0", "c2", "The storm"), 1).shortLabel
    expect(badge).not.toMatch(/^\d/)
  })
})

describe("planUserMilestones", () => {
  it("replaces app-invented divisions, even across two of them", () => {
    // Five cells: Part 1 covers c0–c2, Part 2 covers c3–c4. A milestone from
    // c2 to c3 crosses a boundary the APP invented, which is allowed.
    const resolved = [part(1), part(1), part(1), part(2), part(2)]
    const plan = planUserMilestones(order(5), resolved, [record("ms", "c2", "c3", "The storm")])

    expect(plan.placements).toHaveLength(1)
    expect(plan.placements[0]).toMatchObject({ mode: "replace", startIndex: 2, endIndex: 3 })
    expect([...plan.replacedIndices].sort()).toEqual([2, 3])
  })

  it("replaces a run of 5-minute buckets", () => {
    const resolved = [bucket(0), bucket(0), bucket(300_000), bucket(300_000)]
    const plan = planUserMilestones(order(4), resolved, [record("ms", "c2", "c3")])
    expect(plan.placements[0]).toMatchObject({ mode: "replace" })
  })

  it("nests inside one division the file supplied, without touching it", () => {
    const resolved = [chapter(4), chapter(4), chapter(4), chapter(4)]
    const plan = planUserMilestones(order(4), resolved, [record("ms", "c1", "c2", "The calming")])

    expect(plan.placements[0]).toMatchObject({
      mode: "nest",
      parentKey: "scripture:MRK:4",
      startIndex: 1,
      endIndex: 2,
    })
    // Nothing is replaced, so the chapter's own cells and figures are intact.
    expect(plan.replacedIndices.size).toBe(0)
  })

  it("skips a milestone that crosses a boundary the file supplied", () => {
    const resolved = [chapter(4), chapter(4), chapter(5), chapter(5)]
    const plan = planUserMilestones(order(4), resolved, [record("ms", "c1", "c2")])
    expect(plan.placements).toEqual([])
  })

  it("skips a milestone spanning a file-supplied division and an app-invented one", () => {
    const resolved = [chapter(4), chapter(4), part(1), part(1)]
    const plan = planUserMilestones(order(4), resolved, [record("ms", "c1", "c2")])
    expect(plan.placements).toEqual([])
  })

  it("keeps placements in file order and skips an overlapping record", () => {
    const resolved = [part(1), part(1), part(1), part(1), part(1), part(1)]
    const plan = planUserMilestones(order(6), resolved, [
      record("late", "c4", "c5", "Third"),
      record("overlap", "c1", "c3", "Skipped"),
      record("early", "c0", "c2", "First"),
    ])
    expect(plan.placements.map((p) => p.milestone.label)).toEqual(["First", "Third"])
  })

  it("is a no-op with no hand-set milestones", () => {
    const plan = planUserMilestones(order(3), [part(1), part(1), part(1)], [])
    expect(plan.placements).toEqual([])
    expect(plan.replacedIndices.size).toBe(0)
  })
})

describe("refusalForUserMilestone", () => {
  const norm = normalizeMilestoneName

  it("accepts a range over app-invented divisions", () => {
    expect(refusalForUserMilestone(
      order(4), [part(1), part(1), part(2), part(2)], [],
      { name: "The storm", startCellId: "c1", endCellId: "c2" }, norm,
    )).toBeNull()
  })

  it("accepts a range wholly inside one file-supplied division", () => {
    expect(refusalForUserMilestone(
      order(4), [chapter(4), chapter(4), chapter(4), chapter(4)], [],
      { name: "The calming", startCellId: "c1", endCellId: "c2" }, norm,
    )).toBeNull()
  })

  it.each([
    ["", "blank-name"],
    ["   ", "blank-name"],
  ])("refuses the name %o", (name, reason) => {
    expect(refusalForUserMilestone(
      order(3), [part(1), part(1), part(1)], [],
      { name, startCellId: "c0", endCellId: "c1" }, norm,
    )).toEqual({ reason })
  })

  it("refuses a range with no end picked yet", () => {
    expect(refusalForUserMilestone(
      order(3), [part(1), part(1), part(1)], [],
      { name: "n", startCellId: "c0", endCellId: "" }, norm,
    )).toEqual({ reason: "no-range" })
  })

  it("refuses an end anchor that sits before the start", () => {
    expect(refusalForUserMilestone(
      order(3), [part(1), part(1), part(1)], [],
      { name: "n", startCellId: "c2", endCellId: "c0" }, norm,
    )).toEqual({ reason: "backwards" })
  })

  it("names the chapter a range would run into", () => {
    expect(refusalForUserMilestone(
      order(4), [chapter(4), chapter(4), chapter(5), chapter(5)], [],
      { name: "n", startCellId: "c1", endCellId: "c2" }, norm,
    )).toEqual({ reason: "crosses-division", divisionLabel: "Mark 5" })
  })

  it("names the hand-set milestone a range would overlap", () => {
    expect(refusalForUserMilestone(
      order(6), Array.from({ length: 6 }, () => part(1)),
      [record("ms-1", "c0", "c2", "The storm")],
      { name: "Another", startCellId: "c2", endCellId: "c4" }, norm,
    )).toEqual({ reason: "overlaps", milestoneName: "The storm" })
  })

  it("lets a milestone being edited keep its own range", () => {
    expect(refusalForUserMilestone(
      order(6), Array.from({ length: 6 }, () => part(1)),
      [record("ms-1", "c0", "c2", "The storm")],
      { id: "ms-1", name: "The storm, renamed", startCellId: "c0", endCellId: "c3" }, norm,
    )).toBeNull()
  })

  it("allows a milestone that merely touches an existing one", () => {
    expect(refusalForUserMilestone(
      order(6), Array.from({ length: 6 }, () => part(1)),
      [record("ms-1", "c0", "c2", "The storm")],
      { name: "Next", startCellId: "c3", endCellId: "c5" }, norm,
    )).toBeNull()
  })

  // AQU-2310: the dialog is handed the navigator's divisions AFTER hand-set
  // milestones, so the cells a milestone holds read as its own `user:`
  // division. Widening it into the part beside it is not crossing anything.
  describe("editing a milestone in place, against the navigator's divisions", () => {
    const storm = record("ms-1", "c1", "c2", "The storm")
    const stormDivision = userMilestoneIdentity(storm, 1)
    const navigator = [part(1), stormDivision, stormDivision, part(2), part(2)]

    it("lets it grow into the app-made part beside it", () => {
      expect(refusalForUserMilestone(
        order(5), navigator, [storm],
        { id: "ms-1", name: "The storm", startCellId: "c1", endCellId: "c3" }, norm,
      )).toBeNull()
    })

    it("still refuses a NEW range reaching into it, by name", () => {
      expect(refusalForUserMilestone(
        order(5), navigator, [storm],
        { name: "Other", startCellId: "c2", endCellId: "c3" }, norm,
      )).toEqual({ reason: "overlaps", milestoneName: "The storm" })
    })

    it("refuses a nested one running out of its chapter, naming the chapter", () => {
      const calming = record("ms-2", "c1", "c2", "The calming")
      expect(refusalForUserMilestone(
        order(4), [chapter(4), chapter(4), chapter(4), chapter(5)], [calming],
        { id: "ms-2", name: "The calming", startCellId: "c1", endCellId: "c3" }, norm,
      )).toEqual({ reason: "crosses-division", divisionLabel: "Mark 5" })
    })
  })
})

describe("userMilestoneIdFromKey", () => {
  it("reads the record id back out of a hand-set milestone's key", () => {
    expect(userMilestoneIdFromKey(userMilestoneKey("ms-1"))).toBe("ms-1")
  })

  it.each([
    "part:c0",
    "scripture:MRK:4",
    // The 50-cell jump ranges under a long hand-set milestone.
    "user:ms-1:range:c50",
    "user:",
  ])("is null for %o", (key) => {
    expect(userMilestoneIdFromKey(key)).toBeNull()
  })
})

describe("milestoneRowActions", () => {
  it("offers rename, edit range and remove on a hand-set milestone", () => {
    expect(milestoneRowActions({ key: "user:ms-1", kind: "user" }))
      .toEqual(["rename", "editRange", "remove"])
  })

  it("offers the same on one nested under a chapter, which carries no kind", () => {
    expect(milestoneRowActions({ key: "user:ms-1" })).toEqual(["rename", "editRange", "remove"])
  })

  it.each([
    ["part:c0", "part"],
    ["part:c0#2", "part"],
    ["time:300000", "time-range"],
    ["ai:c0", "ai-section"],
  ] as const)("offers only rename on the app-made row %o", (key, kind) => {
    expect(milestoneRowActions({ key, kind })).toEqual(["rename"])
  })

  it.each([
    ["scripture:MRK:4", "chapter"],
    ["heading:intro", "section"],
    ["slide:3", "slide"],
    ["story:s1", "story"],
  ] as const)("offers nothing on the file-supplied row %o", (key, kind) => {
    expect(milestoneRowActions({ key, kind })).toEqual([])
  })

  it("offers nothing on a 50-cell jump range", () => {
    expect(milestoneRowActions({ key: "scripture:MRK:4:range:c50" })).toEqual([])
    expect(milestoneRowActions({ key: "user:ms-1:range:c50" })).toEqual([])
  })
})
