import { describe, it, expect } from "vitest"
import { canEditCellLabel } from "./cell-label-gate"
import { ROLE } from "@/lib/frontier/roles"

describe("canEditCellLabel (AQU-2408)", () => {
  it("admits maintainers and owners by default — the tier is maintainer when unset", () => {
    expect(canEditCellLabel({ roleLevel: ROLE.MAINTAINER, settings: {} })).toBe(true)
    expect(canEditCellLabel({ roleLevel: ROLE.OWNER, settings: null })).toBe(true)
    expect(canEditCellLabel({ roleLevel: ROLE.MAINTAINER, settings: undefined })).toBe(true)
  })

  it("refuses a project lead until the project opens the tier to project leads", () => {
    expect(canEditCellLabel({ roleLevel: ROLE.PROJECT_LEAD, settings: {} })).toBe(false)
    expect(canEditCellLabel({ roleLevel: ROLE.PROJECT_LEAD, settings: { cellLabelFloor: "maintainer" } })).toBe(false)
    expect(canEditCellLabel({ roleLevel: ROLE.PROJECT_LEAD, settings: { cellLabelFloor: "project_lead" } })).toBe(true)
  })

  it("never admits a contributor or below, whatever the tier — the static floor is project lead", () => {
    for (const level of [ROLE.CONTRIBUTOR, ROLE.REVIEWER, ROLE.COMMENTER, ROLE.VIEWER]) {
      expect(canEditCellLabel({ roleLevel: level, settings: { cellLabelFloor: "project_lead" } })).toBe(false)
    }
  })

  it("does not fail open on an unknown role", () => {
    expect(canEditCellLabel({ roleLevel: null, settings: { cellLabelFloor: "project_lead" } })).toBe(false)
    expect(canEditCellLabel({ roleLevel: undefined, settings: {} })).toBe(false)
  })
})
