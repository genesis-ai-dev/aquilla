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

// AQU-1510. WHY: two assignments on one book looked like "two projects per
// book" because the only thing telling them apart, "MAT 1, MAT 2, … MAT 28",
// was clipped or scrolled away. Read as ranges, the label fits and says it.
describe("assignmentScopeText", () => {
  const chapters = (scopeLabel: string) => ({ scopeKind: "chapters", scopeLabel })
  it("collapses consecutive chapters into ranges, book by book", async () => {
    const { assignmentScopeText } = await import("./assignment-landing")
    const label = Array.from({ length: 28 }, (_, i) => `MAT ${i + 1}`).join(", ")
    expect(assignmentScopeText(chapters(label))).toBe("MAT 1–28")
    expect(assignmentScopeText(chapters("LUK 22, LUK 23, LUK 24"))).toBe("LUK 22–24")
    expect(assignmentScopeText(chapters("MAT 5, MAT 1, MAT 2, MAT 3, MRK 2"))).toBe("MAT 1–3, 5 · MRK 2")
    expect(assignmentScopeText(chapters("Matthew · MAT 21, MAT 22"))).toBe("MAT 21–22")
  })

  it("keeps any other scope's label as it is", async () => {
    const { assignmentScopeText } = await import("./assignment-landing")
    expect(assignmentScopeText({ scopeKind: "books", scopeLabel: "All verses" })).toBe("All verses")
    expect(assignmentScopeText({ scopeKind: "file", scopeLabel: "MAT.usfm" })).toBe("MAT.usfm")
  })
})

// Media redesign slice 2 (P2.2): the inbox lands where the language's work is.
describe("resolveAssignmentLandingCell by what the language delivers", () => {
  const verse = (cellId: string, over: Partial<ShortVerse> = {}): ShortVerse =>
    ({ cellId, ref: cellId, filled: false, validated: false, recorded: false, audioValidated: false, ...over })
  const ruth1 = async () => [
    verse("1:6", { recorded: true, audioValidated: true }),
    verse("1:7", { recorded: true }),
    verse("1:8"),
  ]

  it("Audio: the first line without an approved recording, whatever its text", async () => {
    expect(await resolveAssignmentLandingCell(chapters("RUT 1"), ruth1, "audio")).toBe("1:7")
  })

  it("Text and audio: the first line not done on both halves", async () => {
    const read = async () => [
      verse("a", { filled: true, validated: true, recorded: true, audioValidated: true }),
      verse("b", { filled: true, validated: true }),
      verse("c", { recorded: true, audioValidated: true }),
    ]
    expect(await resolveAssignmentLandingCell(chapters("RUT 1"), read, "text_and_audio")).toBe("b")
  })

  it("Text, and a language nobody has chosen for, keep the text order", async () => {
    for (const delivers of ["text", null, undefined] as const) {
      expect(await resolveAssignmentLandingCell(chapters("RUT 1"), ruth1, delivers)).toBe("1:6")
    }
  })
})
