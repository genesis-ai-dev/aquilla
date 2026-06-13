import { describe, it, expect } from "vitest"
import { deriveNavTitle } from "./deriveTitle"

describe("deriveNavTitle", () => {
  it("maps org-level routes to readable labels", () => {
    expect(deriveNavTitle("/")).toBe("Home")
    expect(deriveNavTitle("/projects")).toBe("Projects")
    expect(deriveNavTitle("/projects/archived")).toBe("Archived projects")
    expect(deriveNavTitle("/assigned")).toBe("Assigned to me")
    expect(deriveNavTitle("/settings")).toBe("Organization settings")
    expect(deriveNavTitle("/teams")).toBe("Teams")
  })

  it("maps project workspace surfaces by their suffix", () => {
    expect(deriveNavTitle("/project/abc")).toBe("Editor")
    expect(deriveNavTitle("/project/abc/file/7")).toBe("File")
    expect(deriveNavTitle("/project/abc/settings")).toBe("Project settings")
    expect(deriveNavTitle("/project/abc/rules")).toBe("Checks & rules")
    expect(deriveNavTitle("/project/abc/terminology")).toBe("Terminology")
    expect(deriveNavTitle("/project/abc/comments")).toBe("Comments")
  })

  it("ignores a trailing slash", () => {
    expect(deriveNavTitle("/projects/")).toBe("Projects")
  })

  it("title-cases an unknown final segment as a fallback", () => {
    expect(deriveNavTitle("/something/else")).toBe("Else")
  })
})
