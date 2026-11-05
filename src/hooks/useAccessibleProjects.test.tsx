import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ProjectsResult } from "@/lib/sync/cloud-projects"
import { useAccessibleProjects, useProjectsForNavigation } from "./useAccessibleProjects"

const authState = vi.hoisted(() => ({
  session: { jwt: "old-jwt", username: "alice", createdAt: "old" },
}))
const fetchProjects = vi.hoisted(() => vi.fn())

vi.mock("./useFrontierSession", () => ({
  useFrontierSession: () => ({ session: authState.session, loading: false }),
}))
vi.mock("@/lib/sync/cloud-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sync/cloud-projects")>()
  return { ...actual, fetchAccessibleProjectsResult: fetchProjects }
})
vi.mock("@/lib/frontier/session-expiry", () => ({
  notifySessionExpiredIfCurrent: vi.fn(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe.each([
  // AQU-2256: the maintainer directory is org-scoped — it needs an org id to
  // fetch at all, so the fencing case passes the org whose roster is open.
  ["maintainer directory", () => useAccessibleProjects(42)],
  ["navigation directory", () => useProjectsForNavigation()],
])("%s request fencing", (_label, useHook) => {
  beforeEach(() => {
    authState.session = { jwt: "old-jwt", username: "alice", createdAt: "old" }
    fetchProjects.mockReset()
  })

  it("ignores the previous credential's response after same-account reauthentication", async () => {
    const oldRequest = deferred<ProjectsResult>()
    const newRequest = deferred<ProjectsResult>()
    fetchProjects.mockImplementation((jwt: string) =>
      jwt === "old-jwt" ? oldRequest.promise : newRequest.promise,
    )
    const hook = renderHook(useHook)
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(1))

    authState.session = { jwt: "new-jwt", username: "alice", createdAt: "new" }
    hook.rerender()
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(2))

    await act(async () => {
      newRequest.resolve({
        ok: true,
        projects: [{
          id: "new-project", name: "New", gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "direct" },
        }],
      })
    })
    await waitFor(() => expect(hook.result.current.projects[0]?.id).toBe("new-project"))

    await act(async () => {
      oldRequest.resolve({
        ok: true,
        projects: [{
          id: "old-project", name: "Old", gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "direct" },
        }],
      })
    })
    expect(hook.result.current.projects[0]?.id).toBe("new-project")
  })
})


// AQU-2256 item 1: the add-to-projects picker hangs off one org's Members
// page. Offering every project the caller maintains anywhere let an org-A
// admin grant an org-A member access to an org-C project, and leaked org-C
// project names onto org-A's page. The org id has to reach the server, and a
// page that does not know its org yet must not fall back to the cross-org list.
describe("useAccessibleProjects org scoping", () => {
  beforeEach(() => {
    authState.session = { jwt: "jwt-1", username: "alice", createdAt: "now" }
    fetchProjects.mockReset()
    fetchProjects.mockResolvedValue({ ok: true, projects: [] })
  })

  it("asks the server for only the given org, at the invite threshold", async () => {
    renderHook(() => useAccessibleProjects(42))
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(1))
    expect(fetchProjects).toHaveBeenCalledWith("jwt-1", 42, undefined, 600)
  })

  it("fetches nothing and stays empty when the org is not known yet", async () => {
    const hook = renderHook(() => useAccessibleProjects(null))
    await waitFor(() => expect(hook.result.current.isLoading).toBe(false))
    expect(fetchProjects).not.toHaveBeenCalled()
    expect(hook.result.current.projects).toEqual([])
    expect(hook.result.current.error).toBeNull()
  })

  it("re-fetches for the new org when the roster switches org", async () => {
    const hook = renderHook(({ orgId }) => useAccessibleProjects(orgId), {
      initialProps: { orgId: 42 as number | null },
    })
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(1))
    hook.rerender({ orgId: 43 })
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(2))
    expect(fetchProjects).toHaveBeenLastCalledWith("jwt-1", 43, undefined, 600)
  })

  it("drops a previous org's response that lands after the switch", async () => {
    const orgA = deferred<ProjectsResult>()
    const orgB = deferred<ProjectsResult>()
    fetchProjects.mockImplementation((_jwt: string, orgId?: number) =>
      orgId === 42 ? orgA.promise : orgB.promise,
    )
    const hook = renderHook(({ orgId }) => useAccessibleProjects(orgId), {
      initialProps: { orgId: 42 as number | null },
    })
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(1))
    hook.rerender({ orgId: 43 })
    await waitFor(() => expect(fetchProjects).toHaveBeenCalledTimes(2))

    await act(async () => {
      orgB.resolve({
        ok: true,
        projects: [{
          id: "org-b-project", name: "B", gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "direct" },
        }],
      })
    })
    await waitFor(() => expect(hook.result.current.projects[0]?.id).toBe("org-b-project"))

    await act(async () => {
      orgA.resolve({
        ok: true,
        projects: [{
          id: "org-a-project", name: "A", gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "direct" },
        }],
      })
    })
    expect(hook.result.current.projects.map((p) => p.id)).toEqual(["org-b-project"])
  })
})
