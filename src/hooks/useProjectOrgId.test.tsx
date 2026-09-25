import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useProjectOrgId } from "./useProjectOrgId"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"
import { notifySessionExpiredIfCurrent } from "@/lib/frontier/session-expiry"

vi.mock("./useFrontierSession", () => ({
  useFrontierSession: () => ({ session: { jwt: "jwt", username: "alice" } }),
}))
// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  resolveCloudProjectResult: vi.fn(),
}))
vi.mock("@/lib/frontier/session-expiry", () => ({
  notifySessionExpiredIfCurrent: vi.fn(),
}))

const resolveProject = vi.mocked(resolveCloudProjectResult)
const notifyExpired = vi.mocked(notifySessionExpiredIfCurrent)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("useProjectOrgId", () => {
  it("resolves the project's own organization", async () => {
    resolveProject.mockResolvedValue({ ok: true, project: { orgId: 7 } } as never)
    const { result } = renderHook(() => useProjectOrgId("p1"))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current).toEqual({ orgId: 7, isLoading: false, error: null })
  })

  it("keeps an unreachable project distinct from an org-less project", async () => {
    resolveProject.mockResolvedValue({ ok: false, reason: "unreachable" })
    const { result } = renderHook(() => useProjectOrgId("p1"))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.orgId).toBeNull()
    expect(result.current.error).toMatch(/offline|connect/i)
  })

  it("signals authentication failure while preserving an explicit error", async () => {
    resolveProject.mockResolvedValue({ ok: false, reason: "unauthenticated" })
    const { result } = renderHook(() => useProjectOrgId("p1"))

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(notifyExpired).toHaveBeenCalledWith("jwt")
  })

  it("does not expose the previous project's organization while the next resolves", async () => {
    let resolveSecond!: (value: unknown) => void
    resolveProject
      .mockResolvedValueOnce({ ok: true, project: { orgId: 7 } } as never)
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveSecond = resolve as (value: unknown) => void
      }))
    const { result, rerender } = renderHook(
      ({ projectId }) => useProjectOrgId(projectId),
      { initialProps: { projectId: "p1" } },
    )

    await waitFor(() => expect(result.current.orgId).toBe(7))
    rerender({ projectId: "p2" })

    expect(result.current.orgId).toBeNull()
    expect(result.current.isLoading).toBe(true)

    resolveSecond({ ok: true, project: { orgId: 9 } })
    await waitFor(() => expect(result.current.orgId).toBe(9))
  })
})
