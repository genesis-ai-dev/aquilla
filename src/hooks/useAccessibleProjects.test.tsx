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
  ["maintainer directory", () => useAccessibleProjects()],
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
