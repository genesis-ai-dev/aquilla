import { describe, it, expect } from "vitest"
import { resolveCellLabelFloor } from "./project-settings"
import { ROLE } from "@/lib/frontier/roles"

describe("resolveCellLabelFloor (AQU-2408)", () => {
  it("reads an absent key as maintainer", () => {
    expect(resolveCellLabelFloor(undefined)).toBe(ROLE.MAINTAINER)
    expect(resolveCellLabelFloor(null)).toBe(ROLE.MAINTAINER)
    expect(resolveCellLabelFloor({})).toBe(ROLE.MAINTAINER)
    expect(resolveCellLabelFloor({ cellLabelFloor: "maintainer" })).toBe(ROLE.MAINTAINER)
  })

  it("opens to project leads only on the explicit rung", () => {
    expect(resolveCellLabelFloor({ cellLabelFloor: "project_lead" })).toBe(ROLE.PROJECT_LEAD)
  })

  it("never lowers the floor for a value this build does not know", () => {
    expect(resolveCellLabelFloor({ cellLabelFloor: "contributor" as unknown as "maintainer" })).toBe(ROLE.MAINTAINER)
  })
})
