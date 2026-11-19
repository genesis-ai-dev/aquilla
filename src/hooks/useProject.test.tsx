// Phase 2c-β: useProject is a thin client — no IDB cache fallback. Reads
// hit auth-worker on every mount; a 404 surfaces as `not-found`.

import { describe, it, expect, vi, afterEach } from "vitest"
import { act, renderHook, waitFor } from "@testing-library/react"
import { useProject } from "./useProject"
import { getProject } from "@/lib/store/project-index"
import { clearResolvedProjectSeeds, readResolvedProjectSeed, rememberListedProjects } from "@/lib/sync/project-record-seed"
import { announceProjectRecordChanged } from "@/lib/sync/project-record-changed"

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

const projectRecordListeners: Array<(projectId: string) => void> = []

vi.mock("@/lib/store/project-index", () => ({
  getProject: vi.fn(async () => undefined),
  subscribeProjectRecords: vi.fn((listener: (projectId: string) => void) => {
    projectRecordListeners.push(listener)
    return () => {
      const i = projectRecordListeners.indexOf(listener)
      if (i >= 0) projectRecordListeners.splice(i, 1)
    }
  }),
}))

const originalFetch = global.fetch
const mockedGetProject = vi.mocked(getProject)

afterEach(() => {
  global.fetch = originalFetch
  clearResolvedProjectSeeds()
  projectRecordListeners.length = 0
  vi.restoreAllMocks()
})

describe("useProject — thin-client fetch (Phase 2c-β)", () => {
  it("renders an initial project immediately while revalidating in the background", () => {
    global.fetch = vi.fn<typeof fetch>(() => new Promise(() => {})) as unknown as typeof fetch

    const initialProject = {
      id: "p-seeded",
      name: "Seeded project",
      sourceLanguage: "English",
      targetLanguage: "French",
      createdAt: "",
      files: [],
      members: [],
      syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
    } as never

    const { result } = renderHook(() => useProject("p-seeded", {
      initialProject,
      includeSettings: false,
    }))

    expect(result.current.status).toBe("ready")
    expect(result.current.loading).toBe(false)
    expect(result.current.project?.name).toBe("Seeded project")
  })

  it("reuses an ancestor-owned project without starting another resolve", () => {
    const fetchSpy = vi.fn<typeof fetch>(() => new Promise(() => {}))
    global.fetch = fetchSpy as unknown as typeof fetch
    const initialProject = {
      id: "p-owned",
      name: "Workspace project",
      files: [],
      members: [],
      syncRole: { level: 700, name: "owner", source: "creator", fetchedAt: "" },
    } as never

    const { result } = renderHook(() => useProject("p-owned", {
      initialProject,
      enabled: false,
      includeSettings: false,
    }))

    expect(result.current.status).toBe("ready")
    expect(result.current.project?.name).toBe("Workspace project")
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // AQU-1325: a second mount of the same project (overview → editor) starts
  // `ready` from the record the first resolve produced, so the workspace
  // chrome and name paint at once while the server round-trip revalidates.
  it("seeds a later mount from a previous resolve and still revalidates", async () => {
    let calls = 0
    global.fetch = vi.fn<typeof fetch>(async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          id: "p-seed",
          name: calls === 1 ? "First name" : "Renamed on server",
          gitlabProjectId: null,
          role: { level: 700, name: "owner", source: "creator" },
          files: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch

    const first = renderHook(() => useProject("p-seed", { includeSettings: false }))
    expect(first.result.current.status).toBe("loading")
    await waitFor(() => expect(first.result.current.status).toBe("ready"))
    expect(readResolvedProjectSeed("p-seed")?.name).toBe("First name")
    first.unmount()

    const second = renderHook(() => useProject("p-seed", { includeSettings: false }))
    // Synchronously ready from the seed — no skeleton frame.
    expect(second.result.current.status).toBe("ready")
    expect(second.result.current.project?.name).toBe("First name")
    expect(second.result.current.roleLevel).toBe(700)
    // The authoritative fetch still runs and its answer wins.
    await waitFor(() => expect(second.result.current.project?.name).toBe("Renamed on server"))
    expect(calls).toBe(2)
  })

  // A project clicked in a list has never been resolved in this tab, but the
  // list was drawn from the account's directory: its name, role, PM and files
  // are known. The page paints from that instead of a loader. It is marked
  // provisional because the directory is as old as the session — the workspace
  // must not redirect away from a file it does not list yet — and the
  // project's own read then replaces it.
  it("paints a never-opened project from the directory, provisionally, until its own read lands", async () => {
    rememberListedProjects([
      {
        id: "p-listed",
        name: "Listed name",
        gitlabProjectId: null,
        orgId: 7,
        role: { level: 500, name: "translator", source: "org" },
        pm: { id: 3, username: "sam" },
        files: [{ id: "f-old", name: "Old file.usfm", type: "usfm", cellCount: 4 }],
      } as never,
    ])
    let release!: (response: Response) => void
    global.fetch = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { release = resolve })) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-listed", { includeSettings: false }))
    expect(result.current.status).toBe("ready")
    expect(result.current.provisional).toBe(true)
    expect(result.current.project?.name).toBe("Listed name")
    expect(result.current.project?.orgId).toBe(7)
    expect(result.current.project?.files.map((f) => f.id)).toEqual(["f-old"])
    expect(result.current.roleLevel).toBe(500)
    expect(result.current.pm).toEqual({ id: 3, username: "sam" })

    await waitFor(() => expect(release).toBeTypeOf("function"))
    await act(async () => {
      release(new Response(
        JSON.stringify({
          id: "p-listed",
          name: "Listed name",
          gitlabProjectId: null,
          role: { level: 600, name: "maintainer", source: "override" },
          files: [
            { id: "f-old", name: "Old file.usfm", type: "usfm", cellCount: 4 },
            { id: "f-new", name: "Added since.usfm", type: "usfm", cellCount: 9 },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ))
    })
    await waitFor(() => expect(result.current.provisional).toBe(false))
    expect(result.current.project?.files.map((f) => f.id)).toEqual(["f-old", "f-new"])
    expect(result.current.roleLevel).toBe(600)
  })

  it("lets go of a directory record the server now refuses", async () => {
    rememberListedProjects([
      { id: "p-revoked", name: "Was shared", gitlabProjectId: null, role: { level: 300, name: "viewer", source: "org" }, files: [] } as never,
    ])
    global.fetch = vi.fn<typeof fetch>(async () => new Response("", { status: 403 })) as unknown as typeof fetch
    const { result } = renderHook(() => useProject("p-revoked", { includeSettings: false }))
    expect(result.current.project?.name).toBe("Was shared")
    await waitFor(() => expect(result.current.status).toBe("forbidden"))
    expect(result.current.project).toBeNull()
    expect(result.current.provisional).toBe(false)
  })

  it("prefers a previous resolve over the directory, and is not provisional", async () => {
    global.fetch = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ id: "p-both", name: "Resolved name", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" }, files: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch
    const first = renderHook(() => useProject("p-both", { includeSettings: false }))
    await waitFor(() => expect(first.result.current.status).toBe("ready"))
    first.unmount()
    rememberListedProjects([
      { id: "p-both", name: "Directory name", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" }, files: [] } as never,
    ])
    const second = renderHook(() => useProject("p-both", { includeSettings: false }))
    expect(second.result.current.project?.name).toBe("Resolved name")
    expect(second.result.current.provisional).toBe(false)
  })

  it("takes the cold path when no resolve of this project has happened in the tab", () => {
    global.fetch = vi.fn<typeof fetch>(() => new Promise(() => {})) as unknown as typeof fetch
    const { result } = renderHook(() => useProject("p-cold", { includeSettings: false }))
    expect(result.current.status).toBe("loading")
    expect(readResolvedProjectSeed("p-cold")).toBeNull()
  })

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

  // AQU-1570: Project Settings is a route modal over a still-mounted page with
  // its own useProject. When the dialog links a source project, the page behind
  // must re-read the record — that is where the upstream's files show up.
  it("re-resolves when another surface in the tab announces this project changed", async () => {
    let files: Array<{ id: string; name: string; type: string; cellCount: number }> = []
    const reads: string[] = []
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      reads.push(url)
      if (url === `${API}/api/v2/projects/p-linked`) {
        return new Response(
          JSON.stringify({
            id: "p-linked",
            name: "Downstream",
            gitlabProjectId: null,
            role: { level: 700, name: "owner", source: "creator" },
            files,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const { result } = renderHook(() => useProject("p-linked", { includeSettings: false }))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.project?.files).toEqual([])

    // Another project's change is not this page's business.
    act(() => announceProjectRecordChanged("p-other"))
    expect(reads).toHaveLength(1)

    files = [{ id: "f-mat", name: "MAT", type: "usfm", cellCount: 1071 }]
    act(() => announceProjectRecordChanged("p-linked"))

    await waitFor(() => expect(result.current.project?.files.map((f) => f.id)).toEqual(["f-mat"]))
    expect(reads).toHaveLength(2)
  })

  it("overlays device-local completion settings onto the server project", async () => {
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
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      }
      throw new Error(`unexpected fetch: ${url}`)
    }) as unknown as typeof fetch
    mockedGetProject.mockResolvedValueOnce({
      id: "p-1",
      name: "Alpha",
      sourceLanguage: "",
      targetLanguage: "",
      createdAt: "2026-06-14T00:00:00Z",
      files: [],
      members: [],
      aiProviderChosen: true,
      completionSettings: {
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        model: "google/gemma-4-31b-it:free",
        maxTokens: 512,
        temperature: 0.3,
        systemPrompt: "",
        llmHealthPenalty: 0.1,
      },
    })

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.project?.completionSettings).toMatchObject({
      provider: "custom",
      endpoint: "https://openrouter.ai/api/v1",
      model: "google/gemma-4-31b-it:free",
    })
    expect(result.current.project?.aiProviderChosen).toBe(true)
  })

  it("re-overlays device-local completion settings when another route saves them", async () => {
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
    mockedGetProject.mockResolvedValue(undefined)

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(result.current.project?.completionSettings).toBeUndefined()

    mockedGetProject.mockResolvedValue({
      id: "p-1",
      name: "Alpha",
      sourceLanguage: "",
      targetLanguage: "",
      createdAt: "2026-06-14T00:00:00Z",
      files: [],
      members: [],
      aiProviderChosen: true,
      completionSettings: {
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-user",
        model: "",
        maxTokens: 512,
        temperature: 0.3,
        systemPrompt: "",
        llmHealthPenalty: 0.1,
      },
    })
    act(() => {
      for (const listener of projectRecordListeners) listener("p-1")
    })

    await waitFor(() => {
      expect(result.current.project?.completionSettings).toMatchObject({
        provider: "custom",
        endpoint: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-user",
      })
    })
    expect(result.current.project?.aiProviderChosen).toBe(true)
  })

  it("overlays a device-local Autopilot opt-out even without completion settings", async () => {
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
    mockedGetProject.mockResolvedValueOnce({
      id: "p-1",
      name: "Alpha",
      sourceLanguage: "",
      targetLanguage: "",
      createdAt: "2026-06-14T00:00:00Z",
      files: [],
      members: [],
      experimentalFlags: { contextualTranslation: false },
    })

    const { result } = renderHook(() => useProject("p-1"))
    await waitFor(() => expect(result.current.status).toBe("ready"))

    // ProjectOverview consumes this exact record through isFlagEnabled; the
    // false value must survive the real IDB -> useProject producer boundary.
    expect(result.current.project?.experimentalFlags).toEqual({
      contextualTranslation: false,
    })
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
