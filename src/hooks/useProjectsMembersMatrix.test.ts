/**
 * AQU-137: Guards the matrix aggregation logic — the pure data-building pass
 * that is exercised on every refresh().
 *
 * Performance rationale: before AQU-137 the `projects` and `orgMembers` arrays
 * (both plain useState values) were used directly in useCallback deps, causing
 * a new `refresh` function to be created and the fetch effect to re-run on
 * every render even when the project/member sets hadn't changed.  The fix
 * switches to stable ID-based keys (projectsKey, orgMembersKey) so refresh
 * only fires when the actual set of IDs changes.
 *
 * These tests verify the correctness of the aggregation logic at "large"
 * fixture sizes to confirm the O(projects × members) map-building is correct
 * regardless of scale.
 */

import { describe, it, expect } from "vitest"
import type { MatrixCell, MatrixMember } from "./useProjectsMembersMatrix"

// ---------------------------------------------------------------------------
// Pure aggregation extracted for unit testing — mirrors the logic in refresh()
// ---------------------------------------------------------------------------

type FakeProjectMember = {
  userId: number
  username: string
  role: { level: number; name: string; source: string }
}

function buildMatrix(
  perProjectMembers: Array<{ projectId: string; members: FakeProjectMember[] }>,
  orgMembers: Array<{ userId: number; username: string }>,
): {
  cells: Map<number, Map<string, MatrixCell>>
  members: MatrixMember[]
  ownerCountByProject: Map<string, number>
} {
  const cells = new Map<number, Map<string, MatrixCell>>()
  const memberByUserId = new Map<number, MatrixMember>()
  const ownerCountByProject = new Map<string, number>()

  for (const { projectId, members } of perProjectMembers) {
    let ownerCount = 0
    for (const m of members) {
      if (!memberByUserId.has(m.userId)) {
        memberByUserId.set(m.userId, {
          userId: m.userId,
          username: m.username,
          isOrgInherited: m.role.source === "org",
        })
      } else {
        if (m.role.source !== "org") {
          const existing = memberByUserId.get(m.userId)!
          if (existing.isOrgInherited) {
            memberByUserId.set(m.userId, { ...existing, isOrgInherited: false })
          }
        }
      }

      if (!cells.has(m.userId)) cells.set(m.userId, new Map())
      cells.get(m.userId)!.set(projectId, { role: m.role as MatrixCell["role"], secondarySources: (m as any).secondarySources ?? [] })

      if (m.role.level >= 700) ownerCount++
    }
    ownerCountByProject.set(projectId, ownerCount)
  }

  for (const om of orgMembers) {
    if (!memberByUserId.has(om.userId)) {
      memberByUserId.set(om.userId, {
        userId: om.userId,
        username: om.username,
        isOrgInherited: true,
      })
    }
  }

  const sortedMembers = [...memberByUserId.values()].sort((a, b) =>
    a.username.localeCompare(b.username),
  )

  return { cells, members: sortedMembers, ownerCountByProject }
}

// ---------------------------------------------------------------------------

describe("buildMatrix aggregation (AQU-137)", () => {
  it("produces a sparse cells map with the correct role at each intersection", () => {
    const { cells } = buildMatrix(
      [
        {
          projectId: "proj-1",
          members: [{ userId: 1, username: "alice", role: { level: 700, name: "owner", source: "override" } }],
        },
        {
          projectId: "proj-2",
          members: [{ userId: 1, username: "alice", role: { level: 400, name: "contributor", source: "override" } }],
        },
      ],
      [],
    )

    expect(cells.get(1)?.get("proj-1")?.role.level).toBe(700)
    expect(cells.get(1)?.get("proj-2")?.role.level).toBe(400)
    expect(cells.get(1)?.get("proj-3")).toBeUndefined()
  })

  it("promotes isOrgInherited=false when a later project has a non-org source", () => {
    const { members } = buildMatrix(
      [
        {
          projectId: "proj-1",
          members: [{ userId: 5, username: "bob", role: { level: 300, name: "reviewer", source: "org" } }],
        },
        {
          projectId: "proj-2",
          members: [{ userId: 5, username: "bob", role: { level: 400, name: "contributor", source: "override" } }],
        },
      ],
      [],
    )

    const bob = members.find((m) => m.userId === 5)
    expect(bob?.isOrgInherited).toBe(false)
  })

  it("adds org-only members as rows with empty cells (isOrgInherited=true)", () => {
    const { members, cells } = buildMatrix(
      [],
      [{ userId: 99, username: "zara" }],
    )

    const zara = members.find((m) => m.userId === 99)
    expect(zara).toBeDefined()
    expect(zara?.isOrgInherited).toBe(true)
    expect(cells.has(99)).toBe(false)
  })

  it("correctly counts owners per project at scale (50 projects × 20 members)", () => {
    const N_PROJECTS = 50
    const N_MEMBERS = 20

    const perProjectMembers = Array.from({ length: N_PROJECTS }, (_, pi) => ({
      projectId: `proj-${pi}`,
      members: Array.from({ length: N_MEMBERS }, (_, mi) => ({
        userId: mi + 1,
        username: `user${mi + 1}`,
        // First two members are owners, the rest are contributors
        role: { level: mi < 2 ? 700 : 400, name: mi < 2 ? "owner" : "contributor", source: "override" },
      })),
    }))

    const { ownerCountByProject, members, cells } = buildMatrix(perProjectMembers, [])

    // Every project should report exactly 2 owners
    for (let pi = 0; pi < N_PROJECTS; pi++) {
      expect(ownerCountByProject.get(`proj-${pi}`)).toBe(2)
    }
    // All 20 members present
    expect(members).toHaveLength(N_MEMBERS)
    // Each member has a cell in every project (dense fixture)
    for (let mi = 1; mi <= N_MEMBERS; mi++) {
      expect(cells.get(mi)?.size).toBe(N_PROJECTS)
    }
  })

  it("members are sorted alphabetically by username", () => {
    const { members } = buildMatrix(
      [
        {
          projectId: "p1",
          members: [
            { userId: 3, username: "charlie", role: { level: 400, name: "contributor", source: "override" } },
            { userId: 1, username: "alice", role: { level: 400, name: "contributor", source: "override" } },
            { userId: 2, username: "bob", role: { level: 400, name: "contributor", source: "override" } },
          ],
        },
      ],
      [],
    )

    expect(members.map((m) => m.username)).toEqual(["alice", "bob", "charlie"])
  })
})
