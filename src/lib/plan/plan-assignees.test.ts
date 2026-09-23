import { describe, expect, it } from "vitest"
import { mergeUnitAssignees, type UnitAssigneeRow } from "./plan-assignees"
import type { PlanUnit } from "./plan-status"

const unit = (fileId: string, sectionKey: string): PlanUnit => ({
  fileId, fileName: fileId, sectionKey,
  totalCount: 10, filledCount: 5, validatedCount: 2, audioCount: 0, audioValidatedCount: 0,
  lastEditAt: null, targetDate: null, doneAt: null, doneBy: null,
})
const row = (fileId: string, sectionKey: string, userId: number, username = `u${userId}`): UnitAssigneeRow =>
  ({ fileId, sectionKey, userId, username })

const UNITS = [unit("bible", "GEN"), unit("bible", "EXO"), unit("bible", "LEV"), unit("memo", "")]
const WIDE = [row("bible", "GEN", 2, "alice"), row("bible", "GEN", 3, "bob"), row("bible", "EXO", 3, "bob")]

describe("mergeUnitAssignees", () => {
  it("answers EVERY unit once the project-wide read has landed, empty or not", () => {
    // The board's whole reason for the read: a row shows its people from the
    // first paint, and a unit nobody holds says so instead of saying nothing.
    const map = mergeUnitAssignees(UNITS, WIDE, () => undefined)
    expect(map.get("bible:GEN")?.map((a) => a.username)).toEqual(["alice", "bob"])
    expect(map.get("bible:EXO")?.map((a) => a.username)).toEqual(["bob"])
    expect(map.get("bible:LEV")).toEqual([])
    expect(map.get("memo:")).toEqual([])
  })

  it("answers only what the inspector has learned until then", () => {
    // Absent means "not answered": before the project-wide read arrives (or
    // where the org's floor refuses it) the row must not say "unassigned".
    const map = mergeUnitAssignees(UNITS, null, (id) => (id === "bible:LEV" ? [{ userId: 4, username: "carol" }] : undefined))
    expect(map.has("bible:GEN")).toBe(false)
    expect(map.get("bible:LEV")?.map((a) => a.username)).toEqual(["carol"])
  })

  it("lets the inspector's own read overlay the project-wide answer", () => {
    // Right after an assignment is made from the panel, the per-unit read is
    // the one that already knows.
    const map = mergeUnitAssignees(UNITS, WIDE, (id) =>
      id === "bible:EXO" ? [{ userId: 3, username: "bob" }, { userId: 5, username: "dan" }] : undefined)
    expect(map.get("bible:EXO")?.map((a) => a.username)).toEqual(["bob", "dan"])
    expect(map.get("bible:GEN")?.map((a) => a.username)).toEqual(["alice", "bob"])
  })

  it("draws one face per person, whichever source repeats them", () => {
    const map = mergeUnitAssignees(
      UNITS,
      [row("bible", "GEN", 2, "alice"), row("bible", "GEN", 2, "alice")],
      (id) => (id === "bible:EXO" ? [{ userId: 3, username: "bob" }, { userId: 3, username: "bob" }] : undefined),
    )
    expect(map.get("bible:GEN")).toHaveLength(1)
    expect(map.get("bible:EXO")).toHaveLength(1)
  })
})
