import { describe, it, expect, vi } from "vitest"
import { assignmentSectionKeys, resolveAssignmentLandingCell } from "./assignment-landing"
import type { ShortVerse } from "./plan/verse-chips"

const chapters = (scopeLabel: string) => ({ scopeKind: "chapters", scopeLabel, fileId: "f1" })

describe("assignmentSectionKeys", () => {
  it("reads both label shapes, in reading order", () => {
    // The editor's Assign dialog writes bare keys; the org's Assign work
    // dialog puts the file's name first.
    expect(assignmentSectionKeys(chapters("RUT 2"))).toEqual(["RUT 2"])
    expect(assignmentSectionKeys(chapters("RUT 10, RUT 2"))).toEqual(["RUT 2", "RUT 10"])
    expect(assignmentSectionKeys(chapters("Ruth · RUT 3, RUT 1"))).toEqual(["RUT 1", "RUT 3"])
    expect(assignmentSectionKeys(chapters("JON 1, RUT 1"))).toEqual(["RUT 1", "JON 1"])
    expect(assignmentSectionKeys(chapters("1TH 4, 1TH 5 in 1TH.usfm"))).toEqual(["1TH 4", "1TH 5"])
  })

  it("gives a whole-file assignment no sections, so it opens its file", () => {
    expect(assignmentSectionKeys({ scopeKind: "books", scopeLabel: "Entire file" })).toEqual([])
  })
})

describe("resolveAssignmentLandingCell", () => {
  const verse = (cellId: string, filled: boolean, validated: boolean): ShortVerse =>
    ({ cellId, ref: cellId, filled, validated })

  it("lands on the first cell to translate anywhere before an earlier one to validate", async () => {
    const read = vi.fn(async (key: string) => key === "RUT 1"
      ? [verse("a", true, true), verse("b", true, false)]
      : [verse("c", false, false)])
    expect(await resolveAssignmentLandingCell(chapters("RUT 1, RUT 2"), read)).toBe("c")
  })

  it("then the first cell to validate, then the assignment's first cell", async () => {
    expect(await resolveAssignmentLandingCell(chapters("RUT 1"),
      async () => [verse("a", true, true), verse("b", true, false)])).toBe("b")
    expect(await resolveAssignmentLandingCell(chapters("RUT 1"),
      async () => [verse("a", true, true), verse("b", true, true)])).toBe("a")
  })

  it("skips a chapter that cannot be read, and opens the file when none can", async () => {
    const read = vi.fn(async (key: string) => {
      if (key === "RUT 1") throw new Error("HTTP 500")
      return [verse("z", false, false)]
    })
    expect(await resolveAssignmentLandingCell(chapters("RUT 1, RUT 2"), read)).toBe("z")
    expect(await resolveAssignmentLandingCell(chapters("RUT 1"), async () => { throw new Error("x") })).toBeNull()
    expect(await resolveAssignmentLandingCell({ scopeKind: "books", scopeLabel: "Entire file", fileId: "f1" }, read)).toBeNull()
  })
})
