import { describe, expect, it } from "vitest"
import { ALL_UNITS_FOLDER_KEY, groupPlanUnitsByFolder } from "./plan-folders"
import type { PlanUnit } from "./plan-status"

const unit = (fileId: string, over: Partial<PlanUnit> = {}): PlanUnit => ({
  fileId, fileName: fileId, sectionKey: "",
  totalCount: 10, filledCount: 5, validatedCount: 2, audioCount: 0, audioValidatedCount: 0,
  lastEditAt: null, targetDate: null, doneAt: null, doneBy: null,
  ...over,
})
const keys = (units: PlanUnit[]) => groupPlanUnitsByFolder(units).map((g) => g.key)
const members = (units: PlanUnit[], key: string) =>
  groupPlanUnitsByFolder(units).find((g) => g.key === key)!.units.map((u) => u.fileId + (u.sectionKey ? `:${u.sectionKey}` : ""))

describe("groupPlanUnitsByFolder", () => {
  it("groups by the files' corpus markers, the sidebar's folders", () => {
    const units = [
      unit("e1", { corpusMarker: "Season 1" }),
      unit("e3", { corpusMarker: "Season 2" }),
      unit("e2", { corpusMarker: "Season 1" }),
    ]
    expect(keys(units)).toEqual(["Season 1", "Season 2"])
    // The PLAN's order inside a folder, not the sidebar's alphabetical one.
    expect(members(units, "Season 1")).toEqual(["e1", "e2"])
  })

  it("sends a Bible's books to their testaments, canon order kept", () => {
    const units = [
      unit("bible", { sectionKey: "GEN" }),
      unit("bible", { sectionKey: "EXO" }),
      unit("bible", { sectionKey: "MAT" }),
    ]
    expect(keys(units)).toEqual(["OT", "NT"])
    expect(members(units, "OT")).toEqual(["bible:GEN", "bible:EXO"])
    expect(groupPlanUnitsByFolder(units)[0]).toMatchObject({ label: "OT", labelKey: null })
  })

  it("lets a one-book file find its testament by the file's own book code", () => {
    expect(keys([unit("gen", { fileBookCode: "GEN" }), unit("rev", { fileBookCode: "REV" })])).toEqual(["OT", "NT"])
  })

  it("puts marker-less files beside foldered ones under the sidebar's Ungrouped", () => {
    const units = [unit("e1", { corpusMarker: "Season 1" }), unit("notes.txt", { fileKind: "txt" })]
    const groups = groupPlanUnitsByFolder(units)
    expect(groups.map((g) => g.key)).toEqual(["Season 1", "Ungrouped"])
    expect(groups[1]).toMatchObject({ label: null, labelKey: "nav.fileList.ungroupedLabel" })
  })

  it("gives a project with no folders at all ONE group, named for everything", () => {
    // Never zero groups: Collapse all needs something to fold, and the
    // in-order board is never a bare list. "Ungrouped" as the only header
    // would tell a reader something is missing.
    const groups = groupPlanUnitsByFolder([unit("a", { fileKind: "docx" }), unit("b", { fileKind: "txt" })])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: ALL_UNITS_FOLDER_KEY, labelKey: "org.projectOverview.plan.folderAll" })
    expect(groups[0].units.map((u) => u.fileId)).toEqual(["a", "b"])
  })

  it("orders the folders the sidebar's way: testaments first, then by name", () => {
    const units = [
      unit("z", { corpusMarker: "Zeta" }),
      unit("mat", { sectionKey: "MAT", fileId: "bible" }),
      unit("a", { corpusMarker: "Alpha" }),
      unit("gen", { sectionKey: "GEN", fileId: "bible" }),
    ]
    expect(keys(units)).toEqual(["OT", "NT", "Alpha", "Zeta"])
  })

  it("returns nothing for nothing", () => {
    expect(groupPlanUnitsByFolder([])).toEqual([])
  })
})
