// RES-5 (M2-3): Tests for useProject's "unreachable" state distinction.
//
// Verifies that a network failure produces status="unreachable" (not
// "not-found"), and that a 403/404 from the server still produces "not-found".
// This distinction is what allows the UI to show "Can't reach server — Retry"
// instead of "project not found / data deleted" when the backend is down.

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest"
import { renderHook, act, waitFor } from "@testing-library/react"
import type { ResolveProjectResult } from "@/lib/sync/cloud-projects"

// --- mocks ---------------------------------------------------------------

// AQU-1357: partial mock — see src/lib/sync/cloud-projects-mock-guard.test.ts.
vi.mock("@/lib/sync/cloud-projects", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/sync/cloud-projects")>()),
  resolveCloudProjectResult: vi.fn(),
  minimalProjectRecord: vi.fn((project: { id: string; name: string; role: { level: number; name: string; source: string } }) => ({
    id: project.id,
    name: project.name,
    sourceLanguage: "",
    targetLanguage: "",
    createdAt: new Date().toISOString(),
    files: [],
    members: [],
    syncRole: { level: project.role.level, name: project.role.name, source: project.role.source, fetchedAt: new Date().toISOString() },
  })),
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: vi.fn(() => ({
    session: { jwt: "test-jwt", username: "alice" },
    loading: false,
  })),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: vi.fn(() => ({
    settings: {},
    patch: vi.fn(),
  })),
}))

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => undefined),
  subscribeProjectRecords: vi.fn(() => () => {}),
}))

// Import after mocks are registered.
import { useProject } from "./useProject"
import { resolveCloudProjectResult } from "@/lib/sync/cloud-projects"

const mockResolve = vi.mocked(resolveCloudProjectResult)

function setResolveMock(result: ResolveProjectResult) {
  mockResolve.mockImplementation(async () => result)
}

beforeEach(() => {
  mockResolve.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

// --- tests ---------------------------------------------------------------

describe("useProject status distinction", () => {
  it("returns status='unreachable' when resolveCloudProjectResult returns reason='unreachable'", async () => {
    setResolveMock({ ok: false, reason: "unreachable" })

    const { result } = renderHook(() => useProject("p-1"))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status).toBe("unreachable")
    expect(result.current.isError).toBe(false)      // not-found → false
    expect(result.current.isUnreachable).toBe(true)  // unreachable → true
    expect(result.current.project).toBeNull()
  })

  it("returns status='not-found' when resolveCloudProjectResult returns reason='not-found'", async () => {
    setResolveMock({ ok: false, reason: "not-found" })

    const { result } = renderHook(() => useProject("p-2"))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status).toBe("not-found")
    expect(result.current.isError).toBe(true)       // not-found → isError
    expect(result.current.isUnreachable).toBe(false)
    expect(result.current.project).toBeNull()
  })

  it("returns status='forbidden' when resolveCloudProjectResult returns reason='forbidden' (AQU-346)", async () => {
    // WHY: a removed member reloading the workspace URL must land on a clean
    // "you no longer have access" state — distinct from "not-found" (the
    // project exists) and never a live editor rendered from stale caches.
    setResolveMock({ ok: false, reason: "forbidden" })

    const { result } = renderHook(() => useProject("p-revoked"))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status).toBe("forbidden")
    expect(result.current.isError).toBe(true) // forbidden counts as error for legacy consumers
    expect(result.current.isUnreachable).toBe(false)
    expect(result.current.project).toBeNull()
  })

  it("returns status='ready' and populates project when resolve succeeds", async () => {
    setResolveMock({
      ok: true,
      project: {
        id: "p-3",
        name: "Good Project",
        gitlabProjectId: null,
        archivedAt: null,
        archivedBy: null,
        role: { level: 700, name: "owner", source: "creator" },
        files: [],
      },
    })

    const { result } = renderHook(() => useProject("p-3"))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.status).toBe("ready")
    expect(result.current.isError).toBe(false)
    expect(result.current.isUnreachable).toBe(false)
    expect(result.current.project).not.toBeNull()
    expect(result.current.project?.id).toBe("p-3")
    act(() => window.dispatchEvent(new Event("online")))
    expect(mockResolve).toHaveBeenCalledTimes(1)
  })

  it("starts in loading state before the resolve resolves", () => {
    // Make resolve never settle so we capture the "loading" state.
    mockResolve.mockImplementation(() => new Promise(() => {}))

    const { result } = renderHook(() => useProject("p-loading"))
    expect(result.current.status).toBe("loading")
    expect(result.current.loading).toBe(true)
  })

  it("refresh() re-runs the fetch and transitions from unreachable to ready", async () => {
    setResolveMock({ ok: false, reason: "unreachable" })

    const { result } = renderHook(() => useProject("p-retry"))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.status).toBe("unreachable")

    // Simulate server coming back up
    setResolveMock({
      ok: true,
      project: {
        id: "p-retry",
        name: "Retry Project",
        gitlabProjectId: null,
        archivedAt: null,
        archivedBy: null,
        role: { level: 400, name: "contributor", source: "member" },
        files: [],
      },
    })

    act(() => { result.current.refresh() })
    await waitFor(() => {
      expect(result.current.status).toBe("ready")
    })

    expect(result.current.project?.id).toBe("p-retry")
  })
})

// AQU-2372: reconnect can race the request that failed during account switching.
it.each(["unreachable", "forbidden", "not-found"] as const)(
  "revalidates once on reconnect and preserves the server's %s outcome",
  async (reason) => {
    let settleOld!: (value: ResolveProjectResult) => void
    mockResolve.mockImplementationOnce(() => new Promise((resolve) => { settleOld = resolve }))
    const { result, unmount } = renderHook(() => useProject(`reconnect-${reason}`))
    await waitFor(() => expect(mockResolve).toHaveBeenCalledTimes(1))
    setResolveMock({ ok: false, reason })
    act(() => window.dispatchEvent(new Event("online")))
    await waitFor(() => expect(result.current.status).toBe(reason))
    await act(async () => settleOld({ ok: false, reason: "not-found" }))
    expect(result.current.status).toBe(reason)
    expect(mockResolve).toHaveBeenCalledTimes(2)
    unmount()
    act(() => window.dispatchEvent(new Event("online")))
    expect(mockResolve).toHaveBeenCalledTimes(2)
  },
)

// All refresh entry points must share ordering, even when cached chrome is ready.
it.each(["seeded", "manual", "record-change", "session-change"] as const)(
  "keeps the latest project resolve for %s refreshes",
  async (trigger) => {
    const { rememberResolvedProject } = await import("@/lib/sync/project-record-seed")
    const { announceProjectRecordChanged } = await import("@/lib/sync/project-record-changed")
    const { useFrontierSession } = await import("@/hooks/useFrontierSession")
    const id = `ordering-${trigger}`
    const good: ResolveProjectResult = { ok: true, project: {
      id, name: "Recovered", gitlabProjectId: null, archivedAt: null, archivedBy: null,
      role: { level: 400, name: "contributor", source: "member" }, files: [],
    } }
    if (trigger === "seeded") {
      const { minimalProjectRecord } = await import("@/lib/sync/cloud-projects")
      rememberResolvedProject(minimalProjectRecord(good.project))
    }
    let settleOld!: (value: ResolveProjectResult) => void
    mockResolve.mockImplementationOnce(() => new Promise(resolve => { settleOld = resolve }))
    const { result, rerender, unmount } = renderHook(() => useProject(id))
    expect(mockResolve).toHaveBeenCalledTimes(1)
    if (trigger === "seeded") expect(result.current.status).toBe("ready")
    if (trigger === "manual" || trigger === "record-change" || trigger === "session-change") {
      mockResolve.mockImplementationOnce(() => new Promise(resolve => { settleOld = resolve }))
      act(() => {
        if (trigger === "record-change") announceProjectRecordChanged(id)
        else result.current.refresh()
      })
    }
    setResolveMock(good)
    if (trigger === "session-change") {
      const oldSession = vi.mocked(useFrontierSession).getMockImplementation()!
      vi.mocked(useFrontierSession).mockImplementation(() => ({ ...oldSession(), session: { ...oldSession().session!, jwt: "bob-jwt" } }))
      rerender()
      await waitFor(() => expect(result.current.status).toBe("ready"))
      vi.mocked(useFrontierSession).mockImplementation(oldSession)
    } else {
      act(() => window.dispatchEvent(new Event("online")))
      await waitFor(() => expect(result.current.status).toBe("ready"))
      expect(mockResolve).toHaveBeenCalledTimes(trigger === "seeded" ? 2 : 3)
    }
    await act(async () => settleOld({ ok: false, reason: "unreachable" }))
    expect(result.current.status).toBe("ready")
    expect(result.current.project?.name).toBe("Recovered")
    unmount()
  },
)
