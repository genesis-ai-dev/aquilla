// AD-3 thin client: the ProjectRecord consumers see is the server record with
// synced project_settings overlaid. `algorithmicChecks` (built-in check
// enable/severity overrides) must be one of the overlaid keys — it is the
// read half of the Rules-page builtin toggle fix. Without the overlay the
// toggle writes land in D1 but never render, so the control looks dead.

import { describe, it, expect, vi, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useProject } from "./useProject"

const API = "https://api.frontier.example"

vi.mock("@/lib/sync/sync-token", () => ({
  FRONTIER_API_URL: "https://api.frontier.example",
}))

vi.mock("@/hooks/useFrontierSession", () => ({
  useFrontierSession: () => ({
    session: {
      jwt: "test-jwt",
      username: "ryder",
      createdAt: "2026-04-30T00:00:00Z",
    },
    loading: false,
  }),
}))

vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({
    settings: {
      algorithmicChecks: {
        "double-space": { enabled: false },
        "empty-target": { enabled: true, severity: "minor" },
      },
    },
    version: 3,
  }),
}))

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("useProject — algorithmicChecks settings overlay", () => {
  it("overlays synced algorithmicChecks onto the server ProjectRecord", async () => {
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url === `${API}/api/v2/projects/p-1`) {
        return new Response(
          JSON.stringify({
            id: "p-1",
            name: "Alpha",
            gitlabProjectId: null,
            archivedAt: null,
            archivedBy: null,
            role: { level: 700, name: "owner", source: "creator" },
            files: [],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.project?.algorithmicChecks).toEqual({
      "double-space": { enabled: false },
      "empty-target": { enabled: true, severity: "minor" },
    })
  })
})
