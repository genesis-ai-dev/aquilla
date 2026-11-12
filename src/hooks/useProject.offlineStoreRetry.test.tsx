// Desktop, offline cold open: the resolve gives up on an offline store that is
// slow to open, and useProject resolves again once it has opened.

import { describe, it, expect, vi } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import type { ProjectReadResult } from "@/lib/sync/project-resolve"

const h = vi.hoisted(() => ({
  results: [] as ProjectReadResult[],
  openStore: (_open: boolean) => {},
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: { jwt: "test-jwt", username: "ryder", createdAt: "2026-04-30T00:00:00Z" },
    loading: false,
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: {}, version: 0 }),
}))

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => undefined),
  subscribeProjectRecords: vi.fn(() => () => {}),
}))

const resolveProjectForRead = vi.fn(async () => h.results.shift() ?? { ok: false, reason: "unreachable" })

vi.mock("@/lib/sync/project-resolve", () => ({
  resolveProjectForRead: (...args: unknown[]) => resolveProjectForRead(...(args as [])),
  whenOfflineStoreOpen: () => new Promise<boolean>((resolve) => { h.openStore = resolve }),
}))

const { useProject } = await import("./useProject")

const downloaded = {
  id: "p1",
  name: "Downloaded",
  gitlabProjectId: null,
  orgId: 1,
  role: { level: 300, name: "translator", source: "org" },
}

describe("useProject — offline store slow to open", () => {
  it("re-resolves to the offline copy once the store opens", async () => {
    h.results = [
      { ok: false, reason: "unreachable", offlineCopyPending: true },
      { ok: true, project: downloaded, fromOfflineCopy: true } as ProjectReadResult,
    ]
    const { result } = renderHook(() => useProject("p1", { includeSettings: false }))

    await waitFor(() => expect(result.current.status).toBe("unreachable"))
    h.openStore(true)
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.project?.name).toBe("Downloaded")
    expect(resolveProjectForRead).toHaveBeenCalledTimes(2)
  })

  it("does not retry when the store was open and simply had no copy", async () => {
    resolveProjectForRead.mockClear()
    h.results = [{ ok: false, reason: "unreachable" }]
    const { result } = renderHook(() => useProject("p1", { includeSettings: false }))

    await waitFor(() => expect(result.current.status).toBe("unreachable"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(resolveProjectForRead).toHaveBeenCalledTimes(1)
  })
})
