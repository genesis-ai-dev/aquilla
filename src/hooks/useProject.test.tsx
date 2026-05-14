// Phase 2c-β: useProject is a thin client — no IDB cache fallback. Reads
// hit auth-worker on every mount; a 404 surfaces as `not-found`.

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
  useProjectSettings: () => ({ settings: {}, version: 0 }),
}))

const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("useProject — thin-client fetch (Phase 2c-β)", () => {
  it("populates project.files from the single-project endpoint", async () => {
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
            files: [
              { id: "f-1", name: "GEN", type: "usfm", cellCount: 1533 },
              { id: "f-2", name: "EXO", type: "usfm", cellCount: 1213 },
              { id: "f-3", name: "LEV", type: "usfm", cellCount: 859 },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    await waitFor(() => expect(result.current.project?.files.length).toBe(3))
    expect(result.current.project?.files.map((f) => f.id)).toEqual([
      "f-1",
      "f-2",
      "f-3",
    ])
  })

  it("falls back to the list endpoint when the single-project endpoint 404s", async () => {
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url === `${API}/api/v2/projects/p-1`) {
        return new Response("not found", { status: 404 })
      }
      if (url === `${API}/api/v2/projects`) {
        return new Response(
          JSON.stringify({
            projects: [
              {
                id: "p-1",
                name: "Alpha",
                gitlabProjectId: null,
                role: { level: 700, name: "owner", source: "creator" },
                files: [{ id: "f-9", name: "PSA", type: "usfm", cellCount: 2461 }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.project?.files.length).toBe(1))
    expect(result.current.project?.files[0].id).toBe("f-9")
  })

  it("surfaces not-found when the server has no record", async () => {
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url === `${API}/api/v2/projects/missing-id`) {
        return new Response("not found", { status: 404 })
      }
      if (url === `${API}/api/v2/projects`) {
        return new Response(JSON.stringify({ projects: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("missing-id"))
    await waitFor(() => expect(result.current.status).toBe("not-found"))
    expect(result.current.project).toBeNull()
  })
})
