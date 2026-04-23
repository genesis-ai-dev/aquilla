// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchAccessibleProjects,
  minimalProjectRecord,
  resolveCloudProject,
  type CloudProjectSummary,
} from "./cloud-projects"

const API = "https://api.example.test"
const originalFetch = global.fetch

function mockFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => {
    const text = typeof body === "string" ? body : JSON.stringify(body)
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json" },
    })
  })
}

describe("fetchAccessibleProjects", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("GETs /api/v2/projects with bearer and returns the parsed list", async () => {
    const fetchMock = mockFetch(200, {
      projects: [
        {
          id: "p-1",
          name: "Alpha",
          gitlabProjectId: null,
          role: { level: 700, name: "owner", source: "creator" },
        },
        {
          id: "p-2",
          name: "Beta",
          gitlabProjectId: 42,
          role: { level: 400, name: "contributor", source: "override" },
        },
      ],
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchAccessibleProjects("jwt-user", API)

    expect(result).toHaveLength(2)
    expect(result[0].id).toBe("p-1")
    expect(result[1].role.level).toBe(400)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects`)
    expect(init!.method).toBe("GET")
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer jwt-user")
  })

  it("returns empty array on 401/500/network error instead of throwing", async () => {
    global.fetch = mockFetch(401, { error: "unauth" }) as unknown as typeof fetch
    expect(await fetchAccessibleProjects("jwt", API)).toEqual([])

    global.fetch = mockFetch(500, "boom") as unknown as typeof fetch
    expect(await fetchAccessibleProjects("jwt", API)).toEqual([])

    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    expect(await fetchAccessibleProjects("jwt", API)).toEqual([])
  })
})

describe("minimalProjectRecord", () => {
  const summary: CloudProjectSummary = {
    id: "p-xyz",
    name: "New project",
    gitlabProjectId: null,
    role: { level: 700, name: "owner", source: "creator" },
  }

  it("produces a ProjectRecord with required fields populated", () => {
    const record = minimalProjectRecord(summary)
    expect(record.id).toBe("p-xyz")
    expect(record.name).toBe("New project")
    // Empty defaults the browser can reconcile once the user opens a file.
    expect(record.files).toEqual([])
    expect(record.members).toEqual([])
    // Language fields must be strings (ProjectRecord requires them), even if empty.
    expect(typeof record.sourceLanguage).toBe("string")
    expect(typeof record.targetLanguage).toBe("string")
    expect(typeof record.createdAt).toBe("string")
  })

  it("stamps syncRole from the summary's role so Dashboard can gate actions", () => {
    const record = minimalProjectRecord(summary)
    expect(record.syncRole?.level).toBe(700)
    expect(record.syncRole?.name).toBe("owner")
    expect(record.syncRole?.source).toBe("creator")
    expect(typeof record.syncRole?.fetchedAt).toBe("string")
  })

  it("leaves origin undefined — stub records have no git clone metadata", () => {
    const withGitlab: CloudProjectSummary = { ...summary, gitlabProjectId: 99 }
    expect(minimalProjectRecord(withGitlab).origin).toBeUndefined()
    expect(minimalProjectRecord(summary).origin).toBeUndefined()
  })

  it("propagates archivedAt + archivedBy onto deletedAt / deletedBy so Trash UX fires", () => {
    const archived: CloudProjectSummary = {
      ...summary,
      archivedAt: "2026-04-20T10:00:00Z",
      archivedBy: { id: 17, username: "alice" },
    }
    const record = minimalProjectRecord(archived)
    expect(record.deletedAt).toBe("2026-04-20T10:00:00Z")
    expect(record.deletedBy).toBe("alice")
  })

  it("leaves deletedAt unset when the server reports no archive", () => {
    const record = minimalProjectRecord({ ...summary, archivedAt: null })
    expect(record.deletedAt).toBeUndefined()
    expect(record.deletedBy).toBeUndefined()
  })
})

describe("resolveCloudProject", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("returns the single-project response when that endpoint is available", async () => {
    const calls: string[] = []
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      return new Response(JSON.stringify({
        id: "p-1",
        name: "Alpha",
        gitlabProjectId: null,
        archivedAt: null,
        archivedBy: null,
        role: { level: 700, name: "owner", source: "creator" },
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }) as unknown as typeof fetch

    const result = await resolveCloudProject("p-1", "jwt", API)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("p-1")
    // Should hit the single-project endpoint first, no fallback needed.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe(`${API}/api/v2/projects/p-1`)
  })

  it("falls back to the list endpoint when the single endpoint 404s", async () => {
    // Mirrors the current deployment state where `GET /api/v2/projects/:id`
    // hasn't landed yet but `GET /api/v2/projects` has. Without this fallback
    // URL-paste into a fresh browser dead-ends on "not found".
    const calls: string[] = []
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      calls.push(url)
      if (url.endsWith("/api/v2/projects/p-1")) {
        return new Response("not found", { status: 404 })
      }
      if (url.endsWith("/api/v2/projects")) {
        return new Response(JSON.stringify({
          projects: [
            { id: "p-1", name: "Alpha", gitlabProjectId: null,
              role: { level: 700, name: "owner", source: "creator" } },
            { id: "p-2", name: "Beta", gitlabProjectId: null,
              role: { level: 400, name: "contributor", source: "override" } },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } })
      }
      throw new Error(`unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const result = await resolveCloudProject("p-1", "jwt", API)
    expect(result).not.toBeNull()
    expect(result!.id).toBe("p-1")
    expect(calls).toHaveLength(2)
  })

  it("returns null when neither endpoint has the project", async () => {
    global.fetch = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.endsWith("/api/v2/projects/p-missing")) {
        return new Response("not found", { status: 404 })
      }
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await resolveCloudProject("p-missing", "jwt", API)
    expect(result).toBeNull()
  })
})
