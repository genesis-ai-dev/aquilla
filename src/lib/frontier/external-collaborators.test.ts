import { describe, it, expect } from "vitest"
import { deriveExternalCollaborators } from "./external-collaborators"
import type { ProjectMember } from "@/lib/frontier/members"

// FRO-326: externals must be DERIVED (project/group grant on an org project,
// not an org member) so the list self-heals when the last grant is revoked
// and the role resolver is never touched.

function member(
  userId: number,
  username: string,
  source: ProjectMember["role"]["source"],
  level = 400,
): ProjectMember {
  return {
    userId,
    username,
    role: { level, name: "contributor", source },
    secondarySources: [],
  }
}

const NAMES = new Map([
  ["p1", "Genesis"],
  ["p2", "Exodus"],
])

describe("deriveExternalCollaborators", () => {
  it("lists non-org-members with direct or group grants, grouped per user", () => {
    const matrix = new Map<string, ProjectMember[]>([
      ["p1", [member(1, "alice", "org", 600), member(7, "guest", "override")]],
      ["p2", [member(7, "guest", "group"), member(8, "consultant", "override")]],
    ])
    const externals = deriveExternalCollaborators(matrix, new Set([1]), NAMES)
    expect(externals.map((e) => e.username)).toEqual(["consultant", "guest"])
    const guest = externals.find((e) => e.username === "guest")!
    expect(guest.grants).toEqual([
      { projectId: "p2", projectName: "Exodus", roleLevel: 400, roleName: "contributor", source: "group" },
      { projectId: "p1", projectName: "Genesis", roleLevel: 400, roleName: "contributor", source: "override" },
    ])
  })

  it("never lists org members, regardless of how many project grants they hold", () => {
    const matrix = new Map<string, ProjectMember[]>([
      ["p1", [member(1, "alice", "override", 700)]],
      ["p2", [member(1, "alice", "creator", 700)]],
    ])
    expect(deriveExternalCollaborators(matrix, new Set([1]), NAMES)).toEqual([])
  })

  it("self-heals: a user with no remaining grants simply doesn't appear", () => {
    const before = new Map<string, ProjectMember[]>([["p1", [member(7, "guest", "override")]]])
    const after = new Map<string, ProjectMember[]>([["p1", []]])
    expect(deriveExternalCollaborators(before, new Set(), NAMES)).toHaveLength(1)
    expect(deriveExternalCollaborators(after, new Set(), NAMES)).toEqual([])
  })

  it("skips org-source rows for users missing from the org-members snapshot", () => {
    // Stale-snapshot guard: the matrix says "org" but our org-member set
    // doesn't know them — offering a project-level revoke would be a lie.
    const matrix = new Map<string, ProjectMember[]>([["p1", [member(9, "raced", "org")]]])
    expect(deriveExternalCollaborators(matrix, new Set(), NAMES)).toEqual([])
  })
})
