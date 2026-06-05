/**
 * Tests for getMemberAccess — the client-side call to
 * GET /api/v2/orgs/:orgId/members/:userId/access (AD-12).
 *
 * Verifies:
 * 1. Correct grant paths returned for a mixed-grant member (direct + group).
 * 2. Empty projects array returned for a member with no access.
 * 3. Throws on HTTP error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { getMemberAccess } from "./orgs"

const ORIG = global.fetch
beforeEach(() => { global.fetch = vi.fn() })
afterEach(() => { global.fetch = ORIG })

describe("getMemberAccess", () => {
  it("returns grant paths + resolved role for a mixed-grant member", async () => {
    const payload = {
      orgRole: 100,
      projects: [
        {
          projectId: "pa",
          projectName: "John",
          direct: 300,
          groups: [{ groupId: 5, name: "Translators", roleLevel: 400 }],
          org: 100,
          creator: false,
          resolved: 400, // group contributor wins
        },
        {
          projectId: "pb",
          projectName: "Mark",
          direct: null,
          groups: [],
          org: 100,
          creator: true,
          resolved: 700, // creator wins
        },
      ],
    };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    )

    const result = await getMemberAccess("jwt", 1, 2)

    // Org-level baseline
    expect(result.orgRole).toBe(100)

    // Two projects accessible
    expect(result.projects).toHaveLength(2)

    // Project "pa": direct reviewer overridden by group contributor (max-wins = 400)
    const pa = result.projects.find((p) => p.projectId === "pa")!
    expect(pa.direct).toBe(300)
    expect(pa.groups).toEqual([{ groupId: 5, name: "Translators", roleLevel: 400 }])
    expect(pa.org).toBe(100)
    expect(pa.creator).toBe(false)
    expect(pa.resolved).toBe(400)

    // Project "pb": creator grants owner (700)
    const pb = result.projects.find((p) => p.projectId === "pb")!
    expect(pb.direct).toBeNull()
    expect(pb.creator).toBe(true)
    expect(pb.resolved).toBe(700)
  })

  it("returns empty projects array for a member with no project access", async () => {
    const payload = { orgRole: null, projects: [] };
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status: 200 }),
    )

    const result = await getMemberAccess("jwt", 1, 99)
    expect(result.orgRole).toBeNull()
    expect(result.projects).toHaveLength(0)
  })

  it("throws on non-OK HTTP response", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response("Forbidden", { status: 403 }),
    )
    await expect(getMemberAccess("jwt", 1, 2)).rejects.toThrow("HTTP 403")
  })

  it("calls the correct endpoint", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify({ orgRole: null, projects: [] }), { status: 200 }),
    )
    await getMemberAccess("jwt-abc", 7, 42)
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/v2/orgs/7/members/42/access"),
      expect.any(Object),
    )
  })
})
