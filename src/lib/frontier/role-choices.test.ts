// AQU-2289: one list of roles for each level, capped at what the person
// choosing may grant. Every Change role / Add member door reads it.

import { describe, expect, it } from "vitest"
import { ROLE } from "./roles"
import { roleChoices } from "./role-choices"

const levels = (list: ReadonlyArray<{ level: number }>) => list.map((r) => r.level)

describe("roleChoices", () => {
  it("offers an organization role from the Members table's five, never Commenter or Reviewer", () => {
    expect(levels(roleChoices("org", { callerLevel: ROLE.OWNER, purpose: "change" }))).toEqual([
      ROLE.VIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
      ROLE.OWNER,
    ])
  })

  it("keeps Owner out of adding and inviting: handing over a workspace is a change of an existing member", () => {
    expect(levels(roleChoices("org", { callerLevel: ROLE.OWNER, purpose: "add" }))).toEqual([
      ROLE.VIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
    ])
  })

  it("offers a project role from the project list of six, never Owner", () => {
    expect(levels(roleChoices("project", { callerLevel: ROLE.OWNER }))).toEqual([
      ROLE.VIEWER,
      ROLE.COMMENTER,
      ROLE.REVIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
    ])
  })

  it("never offers more than the person choosing may grant", () => {
    expect(levels(roleChoices("project", { callerLevel: ROLE.PROJECT_LEAD }))).toEqual([
      ROLE.VIEWER,
      ROLE.COMMENTER,
      ROLE.REVIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
    ])
    expect(levels(roleChoices("org", { callerLevel: ROLE.MAINTAINER, purpose: "change" }))).toEqual([
      ROLE.VIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
    ])
  })

  it("keeps the whole list while the caller's own role is not known yet", () => {
    expect(roleChoices("project", { callerLevel: null })).toHaveLength(6)
  })
})
