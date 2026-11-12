import { describe, it, expect } from "vitest"
import { ROLE } from "@/lib/sync/role-policy"
import { extensionEditorWriteCaps } from "../editor-write-caps"

describe("extension editor write capabilities", () => {
  it("lets a contributor edit and validate an open lane", () => {
    expect(extensionEditorWriteCaps({ projectReadOnly: false, laneArchived: false, roleLevel: ROLE.CONTRIBUTOR }))
      .toEqual({ canEdit: true, canValidate: true })
  })

  it("freezes edits and validation in an archived lane, even for a maintainer (AQU-1463)", () => {
    expect(extensionEditorWriteCaps({ projectReadOnly: false, laneArchived: true, roleLevel: ROLE.MAINTAINER }))
      .toEqual({ canEdit: false, canValidate: false })
  })

  it("stops edits but not validation on a read-only project", () => {
    expect(extensionEditorWriteCaps({ projectReadOnly: true, laneArchived: false, roleLevel: ROLE.MAINTAINER }))
      .toEqual({ canEdit: false, canValidate: true })
  })

  it("stays read-only until the active lane's row is known (AQU-1902 'Loading languages…')", () => {
    expect(extensionEditorWriteCaps({ projectReadOnly: false, laneArchived: false, roleLevel: ROLE.MAINTAINER, lanesPending: true }))
      .toEqual({ canEdit: false, canValidate: false })
  })

  it("follows the role ladder: a viewer can do neither", () => {
    expect(extensionEditorWriteCaps({ projectReadOnly: false, laneArchived: false, roleLevel: ROLE.VIEWER }))
      .toEqual({ canEdit: false, canValidate: false })
  })
})
