// AQU-853: the client's copy of the server's project-membership grant rules.
//
// These pin the mirror to `auth-worker/src/routes/projects.ts`
// (`grantProjectMemberOne` + the `callerRole.level < 500` route guard). If a
// case here changes, the server rule changed too — update both.

import { describe, it, expect } from "vitest"
import {
  MEMBER_GRANT_MIN_ROLE,
  canManageProjectMembers,
  grantableProjectRoles,
  roleChangeBlock,
} from "./member-grants"
import { ROLE } from "./roles"

const base = { targetLevel: ROLE.CONTRIBUTOR, isSelf: false, isLocked: false }

describe("roleChangeBlock", () => {
  it("blocks a caller below the project_lead floor", () => {
    expect(roleChangeBlock({ ...base, callerLevel: ROLE.CONTRIBUTOR })).toBe(
      "caller-below-floor",
    )
    expect(roleChangeBlock({ ...base, callerLevel: ROLE.REVIEWER })).toBe(
      "caller-below-floor",
    )
    expect(MEMBER_GRANT_MIN_ROLE).toBe(ROLE.PROJECT_LEAD)
  })

  it("reports the floor ahead of self/locked so the caller learns the real reason", () => {
    expect(
      roleChangeBlock({
        ...base,
        callerLevel: ROLE.CONTRIBUTOR,
        isSelf: true,
        isLocked: true,
      }),
    ).toBe("caller-below-floor")
  })

  it("blocks changing your own role", () => {
    expect(
      roleChangeBlock({ ...base, callerLevel: ROLE.MAINTAINER, isSelf: true }),
    ).toBe("self")
  })

  it("blocks inherited (org / creator) access — there is no direct grant to change", () => {
    expect(
      roleChangeBlock({ ...base, callerLevel: ROLE.MAINTAINER, isLocked: true }),
    ).toBe("locked")
  })

  it("blocks a non-owner from modifying a member at or above their own level", () => {
    expect(
      roleChangeBlock({
        callerLevel: ROLE.PROJECT_LEAD,
        targetLevel: ROLE.PROJECT_LEAD,
        isSelf: false,
        isLocked: false,
      }),
    ).toBe("target-outranks-caller")
    expect(
      roleChangeBlock({
        callerLevel: ROLE.PROJECT_LEAD,
        targetLevel: ROLE.MAINTAINER,
        isSelf: false,
        isLocked: false,
      }),
    ).toBe("target-outranks-caller")
  })

  it("lets an owner modify a member at or above their own level", () => {
    expect(
      roleChangeBlock({
        callerLevel: ROLE.OWNER,
        targetLevel: ROLE.OWNER,
        isSelf: false,
        isLocked: false,
      }),
    ).toBeNull()
  })

  it("allows a lead to change a member strictly below them", () => {
    expect(
      roleChangeBlock({
        callerLevel: ROLE.PROJECT_LEAD,
        targetLevel: ROLE.CONTRIBUTOR,
        isSelf: false,
        isLocked: false,
      }),
    ).toBeNull()
  })

  it("does not block while the caller's own level is still unknown", () => {
    expect(roleChangeBlock({ ...base, callerLevel: null })).toBeNull()
  })
})

describe("grantableProjectRoles", () => {
  it("never offers a role above the caller's own level", () => {
    const levels = grantableProjectRoles(ROLE.PROJECT_LEAD).map((r) => r.level)
    expect(levels).toContain(ROLE.PROJECT_LEAD)
    expect(levels).not.toContain(ROLE.MAINTAINER)
  })

  it("offers the whole project picker to a maintainer", () => {
    const levels = grantableProjectRoles(ROLE.MAINTAINER).map((r) => r.level)
    expect(levels).toEqual([
      ROLE.VIEWER,
      ROLE.COMMENTER,
      ROLE.REVIEWER,
      ROLE.CONTRIBUTOR,
      ROLE.PROJECT_LEAD,
      ROLE.MAINTAINER,
    ])
  })

  it("keeps the full picker while the caller's level is unknown", () => {
    expect(grantableProjectRoles(null)).toHaveLength(6)
  })
})

describe("canManageProjectMembers", () => {
  it("is false below project_lead and true at or above it", () => {
    expect(canManageProjectMembers(ROLE.CONTRIBUTOR)).toBe(false)
    expect(canManageProjectMembers(ROLE.PROJECT_LEAD)).toBe(true)
    expect(canManageProjectMembers(ROLE.OWNER)).toBe(true)
    expect(canManageProjectMembers(null)).toBe(true)
  })
})
