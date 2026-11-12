import { describe, expect, it } from "vitest"
import { findAssignmentOverlap, type OverlapQuery } from "./assignment-overlap"
import type { UnitAssignment, UnitAssignmentChapter } from "./assignments"

const chapter = (key: string, total = 10): UnitAssignmentChapter => ({
  key,
  total,
  translated: 0,
  validated: 0,
  recorded: 0,
  audioValidated: 0,
})

const held = (over: Partial<UnitAssignment> = {}): UnitAssignment => ({
  assignmentId: "a1",
  assigneeUserId: 2,
  username: "nur",
  scopeLabel: "All verses",
  targetLang: "",
  deadline: null,
  cellsTotal: 30,
  translated: 0,
  validated: 0,
  recorded: 0,
  audioValidated: 0,
  chapters: [chapter("MAT 20"), chapter("MAT 21"), chapter("MAT 22")],
  ...over,
})

const query = (over: Partial<OverlapQuery> = {}): OverlapQuery => ({
  assigneeUserId: 2,
  lane: "",
  kind: "translate",
  scope: { kind: "chapters", chapters: ["MAT 21", "MAT 22", "MAT 23"] },
  ...over,
})

describe("findAssignmentOverlap (AQU-1510)", () => {
  it("names the chapters a chapter list would cover again under a whole book", () => {
    expect(findAssignmentOverlap([held()], query())).toEqual({
      scopeLabels: ["All verses"],
      chapters: ["MAT 21", "MAT 22"],
    })
  })

  it("names every held chapter when the new assignment is the whole file", () => {
    const chapters = held({ scopeLabel: "Matthew · MAT 21, MAT 22", chapters: [chapter("MAT 21"), chapter("MAT 22")] })
    expect(findAssignmentOverlap([chapters], query({ scope: { kind: "file" } }))?.chapters).toEqual([
      "MAT 21",
      "MAT 22",
    ])
  })

  it("is null for chapters nobody holds", () => {
    expect(findAssignmentOverlap([held()], query({ scope: { kind: "chapters", chapters: ["MAT 1"] } }))).toBeNull()
  })

  it("ignores someone else's assignment", () => {
    expect(findAssignmentOverlap([held({ assigneeUserId: 9 })], query())).toBeNull()
  })

  it("ignores another language and another kind of work", () => {
    expect(findAssignmentOverlap([held({ targetLang: "fr" })], query())).toBeNull()
    expect(findAssignmentOverlap([held({ kind: "validate" })], query())).toBeNull()
  })

  it("reads the default lane however the picker spells it", () => {
    expect(findAssignmentOverlap([held()], query({ lane: "default" }))).not.toBeNull()
    expect(findAssignmentOverlap([held({ targetLang: "es" })], query({ lane: "es" }))).not.toBeNull()
  })

  it("skips chapters the assignment holds no lines in", () => {
    const thin = held({ chapters: [chapter("MAT 21", 0)] })
    expect(findAssignmentOverlap([thin], query())).toBeNull()
  })

  it("falls back to the label when an older worker sends no chapters", () => {
    expect(findAssignmentOverlap([held({ chapters: undefined })], query())).toEqual({
      scopeLabels: ["All verses"],
      chapters: [],
    })
  })
})
