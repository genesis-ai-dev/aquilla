import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { canSetMilestones } from "./milestone-gate"

describe("canSetMilestones (AQU-2309)", () => {
  it.each([
    ["a maintainer on a project that never set the floor", ROLE.MAINTAINER, undefined, null, true],
    ["a maintainer when the floor is explicit", ROLE.MAINTAINER, "maintainer", null, true],
    ["an owner when the floor is project lead", ROLE.OWNER, "project_lead", null, true],
    ["a project lead on the default floor", ROLE.PROJECT_LEAD, undefined, null, false],
    ["a project lead when the floor is maintainer", ROLE.PROJECT_LEAD, "maintainer", null, false],
    ["a project lead when the floor is project lead", ROLE.PROJECT_LEAD, "project_lead", null, true],
    ["a project lead when the stored tier is unrecognised", ROLE.PROJECT_LEAD, "contributor", null, false],
    ["a contributor even when the floor is project lead", ROLE.CONTRIBUTOR, "project_lead", null, false],
    ["a reviewer even when the floor is project lead", ROLE.REVIEWER, "project_lead", null, false],
    ["a maintainer on a live-linked downstream, floor open", ROLE.MAINTAINER, "project_lead", "live", false],
    ["a project lead on a live-linked downstream, floor open", ROLE.PROJECT_LEAD, "project_lead", "live", false],
    ["a local project with no role, not live-linked", null, undefined, null, true],
    ["a local project that is live-linked", null, "project_lead", "live", false],
  ] as const)("%s", (_label, roleLevel, milestoneFloor, sourceLinkMode, allowed) => {
    expect(canSetMilestones({ roleLevel, milestoneFloor, sourceLinkMode })).toBe(allowed)
  })
})
