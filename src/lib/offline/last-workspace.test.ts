import { beforeEach, describe, expect, it } from "vitest"
import { isLaunchLandingPath, readLastWorkspace, rememberLastWorkspace } from "./last-workspace"

beforeEach(() => localStorage.clear())

describe("last workspace", () => {
  it("round-trips per user", () => {
    rememberLastWorkspace("anna", { projectId: "p1", path: "/project/p1/editor/file/f1" })
    expect(readLastWorkspace("anna")).toEqual({ projectId: "p1", path: "/project/p1/editor/file/f1" })
    expect(readLastWorkspace("ben")).toBeNull()
  })

  it("ignores a stored path outside that project", () => {
    localStorage.setItem("aquilla.offline.lastWorkspace.anna", JSON.stringify({ projectId: "p1", path: "/admin" }))
    expect(readLastWorkspace("anna")).toBeNull()
  })

  it("ignores junk", () => {
    localStorage.setItem("aquilla.offline.lastWorkspace.anna", "{not json")
    expect(readLastWorkspace("anna")).toBeNull()
  })

  it.each([
    ["/", true],
    ["/orgs/all", true],
    ["/orgs/46446/overview", true],
    ["/project/p1/editor", false],
    ["/login", false],
  ])("treats %s as a launch landing: %s", (path, expected) => {
    expect(isLaunchLandingPath(path)).toBe(expected)
  })
})
