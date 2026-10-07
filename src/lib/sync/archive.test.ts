import { describe, it, expect, vi, afterEach } from "vitest"
import {
  archiveProjectRemote,
  unarchiveProjectRemote,
  fetchProjectState,
  runLinkSync,
  triggerLinkSync,
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
        new Response(JSON.stringify({ error: "maintainer+ required to archive a project" }), { status: 403 })
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

// AQU-1544: the client-side mirror-sync trigger. Its answer is what decides
// whether a link flow reports success or says the source files have not
// arrived, so the three ways it can come back are pinned here — against the
// real response shape the sync-worker's /link/sync route sends
// (`{ projectId, ranSync, cellsMirrored, … }`), not a hand-made boolean.
describe("runLinkSync / triggerLinkSync", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => { globalThis.fetch = originalFetch })

  /** sync-token mint succeeds; the /link/sync call answers `syncResponse`. */
  function stubFetch(syncResponse: () => Response | Promise<Response>) {
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.endsWith("/api/v2/sync-token")) {
        return new Response(JSON.stringify({ token: "sync-tok" }), { status: 200 })
      }
      return syncResponse()
    }) as typeof fetch
    return calls
  }

  it("reports content arriving when the sync ran", async () => {
    const calls = stubFetch(
      () =>
        new Response(
          JSON.stringify({
            projectId: "p1", ranSync: true, cellsMirrored: 5543, filesMirrored: 3,
            fromSeq: 0, toSeq: 11102, skippedHashEqual: 0,
          }),
          { status: 200 },
        ),
    )

    expect(await runLinkSync("jwt", "p1", API)).toEqual({ ok: true, ranSync: true })
    expect(await triggerLinkSync("jwt", "p1", API)).toBe(true)
    // Project-scoped token, then the sync itself with THAT token.
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ projectId: "p1", fileId: "__project__" })
    expect(calls[1]!.url).toMatch(/\/api\/v1\/projects\/p1\/link\/sync$/)
    expect((calls[1]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer sync-tok")
  })

  it("reports a sync that worked but had nothing to bring (empty upstream) as ok, not ran", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            projectId: "p1", ranSync: false, cellsMirrored: 0, filesMirrored: 0,
            fromSeq: 0, toSeq: 0, skippedHashEqual: 0,
          }),
          { status: 200 },
        ),
    )

    expect(await runLinkSync("jwt", "p1", API)).toEqual({ ok: true, ranSync: false })
    expect(await triggerLinkSync("jwt", "p1", API)).toBe(true)
  })

  // The exact failure AQU-1544 was found through: the route answers 502 with a
  // plain-text body when the mirror sync throws.
  it("reports failure on a 502 from the sync service", async () => {
    stubFetch(() => new Response("link sync failed: mirror sync failed", { status: 502 }))

    expect(await runLinkSync("jwt", "p1", API)).toEqual({ ok: false })
    expect(await triggerLinkSync("jwt", "p1", API)).toBe(false)
  })

  it("reports failure, without throwing, when the sync service is unreachable", async () => {
    stubFetch(() => {
      throw new TypeError("Failed to fetch")
    })

    expect(await runLinkSync("jwt", "p1", API)).toEqual({ ok: false })
  })

  it("reports failure when the sync token cannot be minted", async () => {
    globalThis.fetch = vi.fn(async () => new Response("forbidden", { status: 403 })) as typeof fetch

    expect(await runLinkSync("jwt", "p1", API)).toEqual({ ok: false })
  })
})
