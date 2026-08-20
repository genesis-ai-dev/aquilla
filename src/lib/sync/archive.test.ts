import { describe, it, expect, vi, afterEach } from "vitest"
import {
  archiveProjectRemote,
  unarchiveProjectRemote,
  fetchProjectState,
} from "./archive"

const API = "https://api.example"

describe("archiveProjectRemote", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it("returns archived on 200", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            archivedAt: "2026-04-23T15:30:00Z",
            archivedBy: { id: 1, username: "alice" },
          }),
          { status: 200 }
        )
    ) as typeof fetch
    const result = await archiveProjectRemote("p1", "jwt", API)
    expect(result).toEqual({
      kind: "archived",
      archivedAt: "2026-04-23T15:30:00Z",
      archivedBy: { id: 1, username: "alice" },
    })
  })

  it("returns local-only on 404", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("not found", { status: 404 })
    ) as typeof fetch
    expect((await archiveProjectRemote("p1", "jwt", API)).kind).toBe("local-only")
  })

  // AQU-820: ProjectOverview/ArchivedProjects render `res.message` verbatim, so
  // it is the keyed status sentence, never the raw (untranslated) server string.
  it("returns forbidden with our keyed message, not the server's text, on 403", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "only owners can archive" }), { status: 403 })
    ) as typeof fetch
    const r = await archiveProjectRemote("p1", "jwt", API)
    expect(r.kind).toBe("forbidden")
    if (r.kind === "forbidden") {
      expect(r.message).toBe("You don't have permission to do that for this project.")
    }
  })

  it("returns error with our keyed message for other statuses", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 })
    ) as typeof fetch
    const r = await archiveProjectRemote("p1", "jwt", API)
    expect(r.kind).toBe("error")
    if (r.kind === "error") {
      expect(r.status).toBe(500)
      expect(r.message).toBe("Something went wrong on the server. Please try again in a moment.")
    }
  })

  it("sends Bearer auth + POST to the archive endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            ok: true,
            archivedAt: "2026-04-23T15:30:00Z",
            archivedBy: { id: 1, username: "alice" },
          }),
          { status: 200 }
        )
    )
    globalThis.fetch = fetchMock
    await archiveProjectRemote("proj 1", "my-jwt", API)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj%201/archive`)
    const headers = init!.headers as Record<string, string>
    expect(headers.Authorization).toBe("Bearer my-jwt")
    expect(init!.method).toBe("POST")
  })
})

describe("unarchiveProjectRemote", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it("returns restored on 200", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    ) as typeof fetch
    expect((await unarchiveProjectRemote("p1", "jwt", API)).kind).toBe("restored")
  })

  it("issues DELETE method", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    )
    globalThis.fetch = fetchMock
    await unarchiveProjectRemote("p1", "jwt", API)
    expect(fetchMock.mock.calls[0][1]!.method).toBe("DELETE")
  })
})

describe("fetchProjectState", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  it("parses the response on 200", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "p1",
            name: "Proj",
            gitlabProjectId: null,
            archivedAt: "2026-04-23T15:30:00Z",
            archivedBy: { id: 1, username: "alice" },
            role: { level: 700, name: "owner", source: "creator" },
          }),
          { status: 200 }
        )
    ) as typeof fetch
    const r = await fetchProjectState("p1", "jwt", API)
    expect(r?.archivedAt).toBe("2026-04-23T15:30:00Z")
    expect(r?.role.level).toBe(700)
  })

  it("returns null on 403 / 404", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("no", { status: 404 })
    ) as typeof fetch
    expect(await fetchProjectState("p1", "jwt", API)).toBeNull()
  })
})
