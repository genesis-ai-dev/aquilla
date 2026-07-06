// @vitest-environment node
// RES-5 (M2-3): Tests for the fetchAccessibleProjectsResult discriminated-union
// return — verifies that server failures are NOT silently mapped to [] (the
// bug the audit found), and that callers can show "Can't reach server" rather
// than "you have no projects".

import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchAccessibleProjectsResult,
  resolveCloudProjectResult,
} from "./cloud-projects"

const API = "https://api.example.test"
const originalFetch = global.fetch

afterEach(() => {
  global.fetch = originalFetch
})

// --- fetchAccessibleProjectsResult ---

describe("fetchAccessibleProjectsResult", () => {
  it("returns ok:true with the project list on 200", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          projects: [
            { id: "p-1", name: "Alpha", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    ) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.projects).toHaveLength(1)
    expect(result.projects[0].id).toBe("p-1")
  })

  it("returns ok:false reason:'unreachable' on network error (not empty array)", async () => {
    // This is the core regression: the old code returned [] here, which the
    // Dashboard rendered as "you have no projects". The new code returns
    // {ok:false, reason:'unreachable'} so the caller can show a proper error.
    global.fetch = vi.fn(async () => { throw new Error("Failed to fetch") }) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("unreachable")
    // status is absent for network errors (not an HTTP status code)
    expect(result.status).toBeUndefined()
  })

  it("returns ok:false reason:'error' on 500 (not empty array)", async () => {
    global.fetch = vi.fn(async () =>
      new Response("Internal Server Error", { status: 500 }),
    ) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("error")
    expect(result.status).toBe(500)
  })

  it("returns ok:false reason:'unauthorized' on 401", async () => {
    global.fetch = vi.fn(async () =>
      new Response("Unauthorized", { status: 401 }),
    ) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("unauthorized")
    expect(result.status).toBe(401)
  })

  it("returns ok:false reason:'unauthorized' on 403", async () => {
    global.fetch = vi.fn(async () =>
      new Response("Forbidden", { status: 403 }),
    ) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("unauthorized")
  })

  it("returns ok:true with empty array when server returns an empty projects list", async () => {
    // An empty list from the server is a LEGITIMATE response (user has no projects)
    // and must NOT be treated as a failure.
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ projects: [] }), { status: 200 }),
    ) as unknown as typeof fetch

    const result = await fetchAccessibleProjectsResult("jwt", undefined, API)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.projects).toEqual([])
  })

  it("appends ?orgId= when given", async () => {
    let capturedUrl = ""
    global.fetch = vi.fn(async (input) => {
      capturedUrl = typeof input === "string" ? input : (input as Request).url
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    await fetchAccessibleProjectsResult("jwt", 7, API)
    expect(capturedUrl).toMatch(/\?orgId=7$/)
  })
})

// --- resolveCloudProjectResult ---

describe("resolveCloudProjectResult", () => {
  it("returns ok:true when the single-project endpoint succeeds", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "p-1", name: "Alpha", gitlabProjectId: null, archivedAt: null, archivedBy: null,
          role: { level: 700, name: "owner", source: "creator" }, files: [],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-1", "jwt", API)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.project.id).toBe("p-1")
  })

  it("returns ok:false reason:'not-found' when project is not in list (404 + empty list)", async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.includes("/api/v2/projects/p-missing")) return new Response("", { status: 404 })
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-missing", "jwt", API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("not-found")
  })

  it("returns ok:false reason:'forbidden' on 403 + not in list (FRO-346 revoked access)", async () => {
    // FRO-346: when a removed member reloads, the direct endpoint 403s. That
    // must NOT collapse into 'not-found' — the project exists; the workspace
    // must show "you no longer have access", not "project not found".
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.includes("/api/v2/projects/p-revoked")) return new Response("", { status: 403 })
      return new Response(JSON.stringify({ projects: [] }), { status: 200 })
    }) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-revoked", "jwt", API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("forbidden")
  })

  it("returns ok:false reason:'unreachable' on network error (not 'not-found')", async () => {
    // Critical regression: a network error must NOT map to 'not-found' because
    // that causes useProject to show "project not found" rather than
    // "can't reach server", misleading the user into thinking data was deleted.
    global.fetch = vi.fn(async () => { throw new Error("Failed to fetch") }) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-1", "jwt", API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("unreachable")
  })

  it("returns ok:false reason:'unreachable' when single-project 404 and list is also unreachable", async () => {
    let calls = 0
    global.fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return new Response("", { status: 404 }) // single-project endpoint
      throw new Error("Network error") // list endpoint also fails
    }) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-1", "jwt", API)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("unreachable")
    expect(result.reason).toBe("unreachable")
  })

  it("falls back to the list endpoint when single-project 404s and finds the project there", async () => {
    global.fetch = vi.fn(async (input) => {
      const url = typeof input === "string" ? input : (input as Request).url
      if (url.includes("/api/v2/projects/p-1") && !url.endsWith("/projects")) {
        return new Response("", { status: 404 })
      }
      return new Response(
        JSON.stringify({
          projects: [{ id: "p-1", name: "Alpha", gitlabProjectId: null, role: { level: 700, name: "owner", source: "creator" } }],
        }),
        { status: 200 },
      )
    }) as unknown as typeof fetch

    const result = await resolveCloudProjectResult("p-1", "jwt", API)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("unreachable")
    expect(result.project.id).toBe("p-1")
  })
})
