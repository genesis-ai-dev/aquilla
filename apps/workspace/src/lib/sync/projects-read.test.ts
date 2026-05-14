import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  ProjectsReadError,
  fetchProject,
  fetchProjectList,
  fetchAccessibleProjects,
} from "./projects-read"

const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchProject", () => {
  it("returns the project record on 200", async () => {
    const project = {
      id: "p1",
      name: "Genesis",
      archivedAt: null,
      archivedBy: null,
      role: { level: 700, name: "owner", source: "creator" },
      files: [],
    }
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(project), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchProject("p1", "jwt", "https://auth.example.com")
    expect(out).toEqual(project)
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toBe("https://auth.example.com/api/v2/projects/p1")
  })

  it("throws on 403", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(fetchProject("p1", "jwt", "https://auth.example.com")).rejects.toBeInstanceOf(
      ProjectsReadError,
    )
  })

  it("encodes the project id", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchProject("p/with slash", "jwt", "https://auth.example.com")
    const url = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string
    expect(url).toContain("p%2Fwith%20slash")
  })
})

describe("fetchProjectList / fetchAccessibleProjects", () => {
  it("returns the projects array from the list endpoint", async () => {
    const projects = [
      {
        id: "p1",
        name: "Genesis",
        role: { level: 700, name: "owner", source: "creator" },
        files: [],
      },
    ]
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ projects }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchProjectList("jwt", "https://auth.example.com")
    expect(out).toEqual(projects)
  })

  it("fetchAccessibleProjects aliases fetchProjectList", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ projects: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchAccessibleProjects("jwt", "https://auth.example.com")
    expect(out).toEqual([])
  })

  it("throws on non-2xx", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("err", { status: 500 }),
    ) as unknown as typeof fetch
    await expect(fetchProjectList("jwt", "https://auth.example.com")).rejects.toBeInstanceOf(
      ProjectsReadError,
    )
  })
})
