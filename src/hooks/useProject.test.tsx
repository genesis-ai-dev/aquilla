import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { renderHook, waitFor } from "@testing-library/react"
import { useProject } from "./useProject"
import { getDb, getProject, updateProject } from "@/lib/store/project-index"

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

// useProjectSettings issues its own fetches and mutates the merged record;
// stub it out so file-list assertions aren't disturbed.
vi.mock("@/hooks/useProjectSettings", () => ({
  useProjectSettings: () => ({ settings: {}, version: 0 }),
}))

const originalFetch = global.fetch

beforeEach(async () => {
  const db = await getDb()
  await db.clear("projects")
})

afterEach(() => {
  global.fetch = originalFetch
  vi.restoreAllMocks()
})

describe("useProject — cold-open hydration", () => {
  // Regression: dashboard's cloud project card showed N files (from the list
  // endpoint), but clicking the card opened a workspace with 0 files because
  // the single-project endpoint never carried the same files[] join. After
  // useProject hydration, an empty record was written to IDB and N→0 stuck
  // both in the sidebar and on the dashboard's local card.
  it("populates project.files from the single-project endpoint and persists to IDB", async () => {
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

    expect(result.current.project?.files.map((f) => f.id)).toEqual(["f-1", "f-2", "f-3"])

    // IDB must reflect the same state — this is what the dashboard's local
    // card reads back to compute its file count, and what the next mount of
    // useProject will surface from cache.
    const stored = await getProject("p-1")
    expect(stored?.files).toHaveLength(3)
    expect(stored?.files.map((f) => f.name)).toEqual(["GEN", "EXO", "LEV"])
  })

  it("falls back to the list endpoint when the single-project endpoint 404s and still preserves files", async () => {
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
    const stored = await getProject("p-1")
    expect(stored?.files).toHaveLength(1)
  })

  it("refreshes a stale stub (cached record with empty files + syncRole) from the server", async () => {
    // Simulates a record persisted by an older client version that hydrated
    // from a server response without files. On next open, useProject should
    // detect the stub and refetch — locking in the recovery path the
    // stale-stub guard at useProject.ts:61 relies on.
    await updateProject({
      id: "p-1",
      name: "Alpha (cached)",
      sourceLanguage: "",
      targetLanguage: "",
      createdAt: "2026-04-29T00:00:00Z",
      files: [],
      members: [],
      syncRole: {
        level: 700,
        name: "owner",
        source: "creator",
        fetchedAt: "2026-04-29T00:00:00Z",
      },
    })

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
            files: [{ id: "f-7", name: "RUT", type: "usfm", cellCount: 85 }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.project?.files.length).toBe(1))
    expect(result.current.project?.files[0].id).toBe("f-7")
    const stored = await getProject("p-1")
    expect(stored?.files).toHaveLength(1)
  })
})
