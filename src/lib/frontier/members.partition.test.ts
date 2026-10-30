// partitionMembers (AQU-454) — moved here from the deleted ProjectMembersPage
// tests (AQU-2259); it is a library function, used by Project settings → Members.
import { describe, it, expect } from "vitest"
import { partitionMembers, type ProjectMember } from "./members"

describe("partitionMembers (AQU-454)", () => {
  const mk = (
    userId: number,
    username: string,
    source: ProjectMember["role"]["source"],
    secondary: ProjectMember["secondarySources"] = [],
  ): ProjectMember => ({
    userId,
    username,
    role: { level: 100, name: "viewer", source },
    secondarySources: secondary,
  })

  it("keeps direct, group, and creator members in the project bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "direct", "override"),
      mk(2, "group", "group"),
      mk(3, "creator", "creator"),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["direct", "group", "creator"])
    expect(orgAccessMembers).toHaveLength(0)
  })

  it("routes org-baseline-only members to the org bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([mk(1, "orgonly", "org")])
    expect(projectMembers).toHaveLength(0)
    expect(orgAccessMembers.map((m) => m.username)).toEqual(["orgonly"])
  })

  it("treats a member with a secondary project path as a project member", () => {
    // Winning path is org (e.g. org owner) but they also hold a direct grant —
    // they belong on the team, not the org-access list.
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "ownerplus", "org", [{ source: "override", level: 400, name: "contributor" }]),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["ownerplus"])
    expect(orgAccessMembers).toHaveLength(0)
  })

  it("preserves order within each bucket", () => {
    const { projectMembers, orgAccessMembers } = partitionMembers([
      mk(1, "a", "override"),
      mk(2, "b", "org"),
      mk(3, "c", "override"),
      mk(4, "d", "org"),
    ])
    expect(projectMembers.map((m) => m.username)).toEqual(["a", "c"])
    expect(orgAccessMembers.map((m) => m.username)).toEqual(["b", "d"])
  })
})
