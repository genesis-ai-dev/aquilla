import { describe, it, expect } from "vitest"
import { deriveNavTitle } from "./deriveTitle"

describe("deriveNavTitle", () => {
  it("maps org-shell routes to readable labels", () => {
    expect(deriveNavTitle("/")).toBe("Home")
    expect(deriveNavTitle("/orgs/all")).toBe("Projects")
    expect(deriveNavTitle("/orgs/7")).toBe("Projects")
    expect(deriveNavTitle("/orgs/7/archived")).toBe("Archived projects")
    expect(deriveNavTitle("/orgs/7/assigned")).toBe("Assigned to me")
    expect(deriveNavTitle("/orgs/7/settings")).toBe("Organization settings")
    expect(deriveNavTitle("/orgs/7/settings/identity")).toBe("Identity")
    expect(deriveNavTitle("/orgs/7/settings/export")).toBe("Export permissions")
    expect(deriveNavTitle("/orgs/7/teams")).toBe("Teams")
    expect(deriveNavTitle("/orgs/7/members")).toBe("Members")
    expect(deriveNavTitle("/orgs/7/members/matrix")).toBe("Members matrix")
  })

  it("maps project workspace surfaces by their suffix", () => {
    expect(deriveNavTitle("/project/abc/editor")).toBe("Editor")
    expect(deriveNavTitle("/project/abc/editor/file/7")).toBe("File")
    expect(deriveNavTitle("/project/abc/settings")).toBe("Project settings")
    expect(deriveNavTitle("/project/abc/settings/ai")).toBe("Project settings")
    expect(deriveNavTitle("/project/abc/rules")).toBe("Checks & rules")
    expect(deriveNavTitle("/project/abc/terminology")).toBe("Terminology")
    expect(deriveNavTitle("/project/abc/comments")).toBe("Comments")
  })

  it("ignores a trailing slash", () => {
    expect(deriveNavTitle("/orgs/7/")).toBe("Projects")
  })

  it("title-cases an unknown final segment as a fallback", () => {
    expect(deriveNavTitle("/something/else")).toBe("Else")
  })
})
