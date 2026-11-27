/**
 * A move must not widen a folder that is limited to some of a project's
 * languages, so the limit is read from each folder before anything moves,
 * and the move is refused when it cannot be read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const getTeam = vi.fn()
const attachProject = vi.fn((..._a: unknown[]) => Promise.resolve({ projectId: "p1", roleLevel: 400 }))
const detachProject = vi.fn((..._a: unknown[]) => Promise.resolve())
vi.mock("@/lib/frontier/teams", () => ({
  getTeam: (...a: unknown[]) => getTeam(...a),
  attachProject: (...a: unknown[]) => attachProject(...a),
  detachProject: (...a: unknown[]) => detachProject(...a),
}))

const { applyProjectMove, withLaneSelections } = await import("./move-project-data")

describe("withLaneSelections", () => {
  beforeEach(() => getTeam.mockReset())

  it("reads a limited folder's languages and leaves an every-language folder alone", async () => {
    getTeam.mockImplementation((_jwt: string, _org: number, id: number) => Promise.resolve({
      id, name: "", members: [],
      projects: id === 1
        ? [{ id: "p1", name: "P", grantedRoleLevel: 400, lanesExplicit: true, laneIds: ["fr"] }]
        : [{ id: "p1", name: "P", grantedRoleLevel: 100, lanesExplicit: false }],
    }))
    const out = await withLaneSelections("jwt", 9, "p1", [
      { folderId: "1", folderName: "A", roleLevel: 400 },
      { folderId: "2", folderName: "B", roleLevel: 100 },
    ])
    expect(out).toEqual([
      { folderId: "1", folderName: "A", roleLevel: 400, laneIds: ["fr"] },
      { folderId: "2", folderName: "B", roleLevel: 100 },
    ])
  })

  it("refuses when a folder cannot be read or no longer holds the project", async () => {
    getTeam.mockRejectedValueOnce(new Error("403"))
    await expect(withLaneSelections("jwt", 9, "p1", [{ folderId: "1", folderName: "A", roleLevel: 400 }])).rejects.toThrow()
    getTeam.mockResolvedValueOnce({ id: 1, name: "", members: [], projects: [] })
    await expect(withLaneSelections("jwt", 9, "p1", [{ folderId: "1", folderName: "A", roleLevel: 400 }])).rejects.toThrow()
  })
})

describe("applyProjectMove", () => {
  it("attaches with the language limit before it detaches", async () => {
    const calls: string[] = []
    attachProject.mockImplementation((...a: unknown[]) => { calls.push(`attach ${a[2]} ${JSON.stringify(a[5])}`); return Promise.resolve({ projectId: "p1", roleLevel: 400 }) })
    detachProject.mockImplementation((...a: unknown[]) => { calls.push(`detach ${a[2]}`); return Promise.resolve() })
    await applyProjectMove("jwt", 9, "p1", { attach: [{ folderId: "3", roleLevel: 400, laneIds: ["fr"] }], detach: ["1"] })
    expect(calls).toEqual(['attach 3 ["fr"]', "detach 1"])
  })
})
