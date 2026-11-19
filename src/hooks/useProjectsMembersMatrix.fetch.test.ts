/**
 * AQU-2654: the batched members matrix is the heaviest read on the Members
 * page. The org id, the project list and the org roster each resolve on their
 * own; the matrix must not be re-fetched once per arrival.
 */
import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectMember } from "@/lib/frontier/members"
import { useProjectsMembersMatrix } from "./useProjectsMembersMatrix"

const state = vi.hoisted(() => ({
  org: { kind: "loading" } as { kind: "loading" } | { kind: "success"; org: { id: number } },
  projects: [] as Array<{ id: string; name: string }>,
  orgMembers: [] as Array<{ userId: number; username: string }>,
}))
const fetchOrgMembersMatrix = vi.hoisted(() => vi.fn())

vi.mock("./useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "ana" }, loading: false }),
}))
vi.mock("./useOrg", () => ({
  useOrg: () => ({ state: state.org }),
  useOrgMembers: () => ({ members: state.orgMembers }),
}))
vi.mock("./useAccessibleProjects", () => ({
  useAccessibleProjects: () => ({ projects: state.projects, error: null }),
}))
vi.mock("@/lib/frontier/members", () => ({ fetchOrgMembersMatrix }))

const member = (userId: number, username: string, level = 300): ProjectMember =>
  ({ userId, username, role: { level, name: "translator", source: "override" } }) as ProjectMember

describe("useProjectsMembersMatrix fetch count (AQU-2654)", () => {
  beforeEach(() => {
    state.org = { kind: "loading" }
    state.projects = []
    state.orgMembers = []
    fetchOrgMembersMatrix.mockReset()
  })

  it("sends the matrix once while the org, the projects and the roster arrive one by one", async () => {
    fetchOrgMembersMatrix.mockResolvedValue(
      new Map([
        ["p1", [member(1, "ana", 700), member(2, "ben")]],
        ["p2", [member(1, "ana", 700)]],
      ]),
    )
    const hook = renderHook(() => useProjectsMembersMatrix())

    state.org = { kind: "success", org: { id: 7 } }
    hook.rerender()
    await waitFor(() => expect(hook.result.current.matrix).not.toBeNull())

    state.projects = [{ id: "p1", name: "Genesis" }, { id: "p2", name: "Exodus" }]
    hook.rerender()
    state.orgMembers = [{ userId: 1, username: "ana" }, { userId: 2, username: "ben" }]
    hook.rerender()
    await act(async () => {})

    expect(fetchOrgMembersMatrix).toHaveBeenCalledTimes(1)
    const matrix = hook.result.current.matrix!
    expect(matrix.projects.map((p) => p.id)).toEqual(["p1", "p2"])
    expect(matrix.members.map((m) => m.username)).toEqual(["ana", "ben"])
    expect(matrix.cells.get(2)?.has("p1")).toBe(true)
    expect(matrix.cells.get(2)?.has("p2")).toBe(false)
    expect(matrix.ownerCountByProject.get("p1")).toBe(1)
  })

  it("keeps the matrix object across a re-read that returns the same ids", async () => {
    fetchOrgMembersMatrix.mockResolvedValue(new Map([["p1", [member(1, "ana")]]]))
    state.org = { kind: "success", org: { id: 7 } }
    state.projects = [{ id: "p1", name: "Genesis" }]
    state.orgMembers = [{ userId: 1, username: "ana" }]
    const hook = renderHook(() => useProjectsMembersMatrix())
    await waitFor(() => expect(hook.result.current.matrix).not.toBeNull())
    const before = hook.result.current.matrix

    state.projects = [{ id: "p1", name: "Genesis" }]
    state.orgMembers = [{ userId: 1, username: "ana" }]
    hook.rerender()
    expect(hook.result.current.matrix).toBe(before)
    expect(fetchOrgMembersMatrix).toHaveBeenCalledTimes(1)
  })

  it("reads again when a project the response never mentioned appears", async () => {
    fetchOrgMembersMatrix
      .mockResolvedValueOnce(new Map([["p1", [member(1, "ana")]]]))
      .mockResolvedValueOnce(new Map([["p1", [member(1, "ana")]], ["p2", [member(2, "ben")]]]))
    state.org = { kind: "success", org: { id: 7 } }
    state.projects = [{ id: "p1", name: "Genesis" }]
    state.orgMembers = [{ userId: 1, username: "ana" }]
    const hook = renderHook(() => useProjectsMembersMatrix())
    await waitFor(() => expect(hook.result.current.matrix).not.toBeNull())
    expect(fetchOrgMembersMatrix).toHaveBeenCalledTimes(1)

    state.projects = [{ id: "p1", name: "Genesis" }, { id: "p2", name: "Exodus" }]
    hook.rerender()
    await waitFor(() => expect(hook.result.current.matrix?.cells.get(2)?.has("p2")).toBe(true))
    expect(fetchOrgMembersMatrix).toHaveBeenCalledTimes(2)
  })

  it("refresh() reads again", async () => {
    fetchOrgMembersMatrix.mockResolvedValue(new Map([["p1", [member(1, "ana")]]]))
    state.org = { kind: "success", org: { id: 7 } }
    state.projects = [{ id: "p1", name: "Genesis" }]
    state.orgMembers = [{ userId: 1, username: "ana" }]
    const hook = renderHook(() => useProjectsMembersMatrix())
    await waitFor(() => expect(hook.result.current.matrix).not.toBeNull())
    await act(async () => { await hook.result.current.refresh() })
    expect(fetchOrgMembersMatrix).toHaveBeenCalledTimes(2)
  })
})
