// AQU-2260: the "View only" marks and the lock lines read one table. It must
// agree with the gates the pages themselves enforce, or a page would say View
// only while letting you edit it (or the reverse).
import { describe, expect, it } from "vitest"
import { ROLE } from "@/lib/frontier/roles"
import { canEditCommentFloors, canEditRosterProgressFloor } from "@/hooks/useOrgSettings"
import { canChangeOrgSettingsPage, ORG_SETTINGS_EDIT_FLOOR } from "./org-settings-access"

const LEVELS = [ROLE.VIEWER, ROLE.COMMENTER, ROLE.REVIEWER, ROLE.CONTRIBUTOR, ROLE.PROJECT_LEAD, ROLE.MAINTAINER, ROLE.OWNER]

describe("org settings edit floors", () => {
  it("Security is the Owner's, like its own floors", () => {
    for (const level of LEVELS) {
      expect(canChangeOrgSettingsPage("security", level)).toBe(canEditRosterProgressFloor(level))
      expect(canChangeOrgSettingsPage("security", level)).toBe(canEditCommentFloors(level))
    }
  })

  it("every other page is a Maintainer's", () => {
    for (const [page, floor] of Object.entries(ORG_SETTINGS_EDIT_FLOOR)) {
      if (page !== "security") expect(floor, page).toBe(ROLE.MAINTAINER)
    }
  })

  it("no role is no access to change anything", () => {
    expect(canChangeOrgSettingsPage("identity", null)).toBe(false)
  })
})
