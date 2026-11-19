import { describe, it, expect } from "vitest"
import { resolveMilestoneFloor } from "./project-settings"
import { ROLE } from "@/lib/frontier/roles"

describe("resolveMilestoneFloor (AQU-2309)", () => {
  it("reads an absent key as maintainer", () => {
    expect(resolveMilestoneFloor(undefined)).toBe(ROLE.MAINTAINER)
    expect(resolveMilestoneFloor(null)).toBe(ROLE.MAINTAINER)
    expect(resolveMilestoneFloor({})).toBe(ROLE.MAINTAINER)
    expect(resolveMilestoneFloor({ milestoneFloor: "maintainer" })).toBe(ROLE.MAINTAINER)
  })

  it("opens to project leads only on the explicit rung", () => {
    expect(resolveMilestoneFloor({ milestoneFloor: "project_lead" })).toBe(ROLE.PROJECT_LEAD)
  })

  it("never lowers the floor for a value this build does not know", () => {
    expect(resolveMilestoneFloor({ milestoneFloor: "contributor" as unknown as "maintainer" })).toBe(ROLE.MAINTAINER)
  })
})
