import { describe, expect, it } from "vitest"
import {
  MILESTONE_NAME_MAX_LENGTH,
  isValidMilestoneId,
  normalizeMilestoneName,
  parseFileMilestone,
  placeMilestone,
  resolveMilestoneSpans,
  type FileMilestone,
} from "./file-milestones"

const record = (
  id: string,
  startCellId: string,
  endCellId: string,
  name = id,
): FileMilestone => ({ id, name, startCellId, endCellId })

describe("normalizeMilestoneName", () => {
  // One table-driven test rather than one `it` per input (AGENTS.md).
  it.each([
    ["The storm", "The storm"],
    ["  The storm  ", "The storm"],
    ["", null],
    ["   ", null],
    ["\t\n ", null],
    [undefined, null],
    [null, null],
    [42, null],
    ["x".repeat(MILESTONE_NAME_MAX_LENGTH), "x".repeat(MILESTONE_NAME_MAX_LENGTH)],
    ["x".repeat(MILESTONE_NAME_MAX_LENGTH + 1), null],
  ])("normalizes %o to %o", (input, expected) => {
    expect(normalizeMilestoneName(input)).toBe(expected)
  })
})

describe("isValidMilestoneId", () => {
  it.each([
    ["0199b0c4-7f3e-7a21-8f0d-3b2c1d4e5f60", true],
    ["ms_1", true],
    ["ms-1", true],
    ["", false],
    ["has space", false],
    ["has/slash", false],
    ["x".repeat(65), false],
  ])("%o -> %o", (input, expected) => {
    expect(isValidMilestoneId(input)).toBe(expected)
  })
})

describe("placeMilestone", () => {
  const order = ["a", "b", "c", "d"]

  it("resolves the run between the two anchors", () => {
    expect(placeMilestone(order, record("m", "b", "d"))).toMatchObject({
      startIndex: 1,
      endIndex: 3,
    })
  })

  it("places a single-cell milestone", () => {
    expect(placeMilestone(order, record("m", "c", "c"))).toMatchObject({
      startIndex: 2,
      endIndex: 2,
    })
  })

  it.each([
    ["a missing start anchor", record("m", "zz", "c")],
    ["a missing end anchor", record("m", "a", "zz")],
    ["an end anchor before the start", record("m", "d", "b")],
  ])("returns null for %s", (_label, milestone) => {
    expect(placeMilestone(order, milestone)).toBeNull()
  })
})

describe("resolveMilestoneSpans", () => {
  const order = ["c0", "c1", "c2", "c3", "c4", "c5", "c6"]

  it("returns placeable milestones in file order, not storage order", () => {
    const spans = resolveMilestoneSpans(order, [
      record("later", "c4", "c5"),
      record("earlier", "c0", "c1"),
    ])
    expect(spans.map((span) => span.milestone.id)).toEqual(["earlier", "later"])
  })

  it("keeps adjacent milestones — touching is not overlapping", () => {
    const spans = resolveMilestoneSpans(order, [
      record("first", "c0", "c2"),
      record("second", "c3", "c5"),
    ])
    expect(spans.map((span) => span.milestone.id)).toEqual(["first", "second"])
  })

  it("skips a milestone that overlaps one starting earlier", () => {
    const spans = resolveMilestoneSpans(order, [
      record("second", "c2", "c6"),
      record("first", "c0", "c3"),
    ])
    expect(spans.map((span) => span.milestone.id)).toEqual(["first"])
  })

  it("skips a milestone entirely contained in an earlier one", () => {
    const spans = resolveMilestoneSpans(order, [
      record("outer", "c0", "c6"),
      record("inner", "c2", "c3"),
    ])
    expect(spans.map((span) => span.milestone.id)).toEqual(["outer"])
  })

  it("breaks a tie on the start anchor by id, so the answer is storage-order independent", () => {
    const forwards = resolveMilestoneSpans(order, [
      record("aaa", "c0", "c1"),
      record("bbb", "c0", "c4"),
    ])
    const backwards = resolveMilestoneSpans(order, [
      record("bbb", "c0", "c4"),
      record("aaa", "c0", "c1"),
    ])
    expect(forwards.map((s) => s.milestone.id)).toEqual(["aaa"])
    expect(backwards.map((s) => s.milestone.id)).toEqual(["aaa"])
  })

  it("drops a record whose anchor is no longer in the file", () => {
    const spans = resolveMilestoneSpans(order, [
      record("orphan", "gone", "c2"),
      record("live", "c4", "c5"),
    ])
    expect(spans.map((span) => span.milestone.id)).toEqual(["live"])
  })
})

describe("parseFileMilestone", () => {
  it("reads a well-formed record and trims its name", () => {
    expect(parseFileMilestone({
      id: "ms-1",
      name: "  The storm  ",
      startCellId: "c0",
      endCellId: "c2",
    })).toEqual({ id: "ms-1", name: "The storm", startCellId: "c0", endCellId: "c2" })
  })

  it.each([
    ["a blank name", { id: "ms-1", name: "  ", startCellId: "c0", endCellId: "c1" }],
    ["an unusable id", { id: "bad id", name: "n", startCellId: "c0", endCellId: "c1" }],
    ["a missing start", { id: "ms-1", name: "n", endCellId: "c1" }],
    ["a missing end", { id: "ms-1", name: "n", startCellId: "c0" }],
    ["a non-object", "nope"],
    ["an array", []],
    ["null", null],
  ])("rejects %s", (_label, input) => {
    expect(parseFileMilestone(input)).toBeUndefined()
  })
})
