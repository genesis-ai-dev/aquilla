import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  SourceLinkingError,
  fetchProjectDownstreams,
  linkProjectToSource,
  detachProjectFromSource,
} from "./source-linking-read"

const ORIG = "https://auth.example.com"
const originalFetch = global.fetch
beforeEach(() => { vi.restoreAllMocks() })
afterEach(() => { global.fetch = originalFetch })

describe("fetchProjectDownstreams", () => {
  it("returns the array of downstream ids on 200, normalizing strings", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ projectId: "p1", downstreams: ["a", "b", "c"] }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    const out = await fetchProjectDownstreams("p1", "jwt", ORIG)
    expect(out).toEqual([{ id: "a" }, { id: "b" }, { id: "c" }])
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe(`${ORIG}/api/v2/projects/p1/downstreams`)
    expect((call[1] as RequestInit).headers).toMatchObject({
      Authorization: "Bearer jwt",
    })
  })

  it("accepts {id, name} entries when the server enriches the response", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          projectId: "p1",
          downstreams: [{ id: "a", name: "Genesis-fr" }],
        }),
        { status: 200 },
      ),
    ) as unknown as typeof fetch
    const out = await fetchProjectDownstreams("p1", "jwt", ORIG)
    expect(out).toEqual([{ id: "a", name: "Genesis-fr" }])
  })

  it("throws SourceLinkingError on 403", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      fetchProjectDownstreams("p1", "jwt", ORIG),
    ).rejects.toBeInstanceOf(SourceLinkingError)
  })

  it("encodes special characters in the project id", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ projectId: "x", downstreams: [] }), { status: 200 }),
    ) as unknown as typeof fetch
    await fetchProjectDownstreams("p/with slash", "jwt", ORIG)
    expect(
      ((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string),
    ).toContain("p%2Fwith%20slash")
  })

  it("treats missing `downstreams` as []", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ projectId: "p1" }), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await fetchProjectDownstreams("p1", "jwt", ORIG)
    expect(out).toEqual([])
  })
})

describe("linkProjectToSource", () => {
  it("POSTs sourceProjectId in the body and returns the link result", async () => {
    const expected = {
      projectId: "p1",
      sourceProjectId: "src",
      previousSourceProjectId: null,
    }
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(expected), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await linkProjectToSource("p1", "src", "jwt", ORIG)
    expect(out).toEqual(expected)
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe(`${ORIG}/api/v2/projects/p1/link-source`)
    const init = call[1] as RequestInit
    expect(init.method).toBe("POST")
    expect(init.headers).toMatchObject({
      Authorization: "Bearer jwt",
      "Content-Type": "application/json",
    })
    expect(JSON.parse(init.body as string)).toEqual({ sourceProjectId: "src" })
  })

  it("throws SourceLinkingError on 409 (cycle)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "linking would create a cycle" }),
        { status: 409 },
      ),
    ) as unknown as typeof fetch
    await expect(
      linkProjectToSource("p1", "src", "jwt", ORIG),
    ).rejects.toMatchObject({ status: 409, name: "SourceLinkingError" })
  })

  it("throws on 404 (source not found)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("not found", { status: 404 }),
    ) as unknown as typeof fetch
    await expect(
      linkProjectToSource("p1", "src", "jwt", ORIG),
    ).rejects.toMatchObject({ status: 404 })
  })

  it("throws on 403 (insufficient role)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    ) as unknown as typeof fetch
    await expect(
      linkProjectToSource("p1", "src", "jwt", ORIG),
    ).rejects.toMatchObject({ status: 403 })
  })
})

describe("detachProjectFromSource", () => {
  it("POSTs and returns snapshot stats on 200", async () => {
    const expected = {
      projectId: "p1",
      previousSourceProjectId: "src",
      snapshottedCellCount: 31102,
    }
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(expected), { status: 200 }),
    ) as unknown as typeof fetch
    const out = await detachProjectFromSource("p1", "jwt", ORIG)
    expect(out).toEqual(expected)
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe(`${ORIG}/api/v2/projects/p1/detach-source`)
    expect((call[1] as RequestInit).method).toBe("POST")
  })

  it("throws SourceLinkingError on 409 (not linked)", async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "project is not linked to an upstream source" }),
        { status: 409 },
      ),
    ) as unknown as typeof fetch
    await expect(
      detachProjectFromSource("p1", "jwt", ORIG),
    ).rejects.toMatchObject({ status: 409, name: "SourceLinkingError" })
  })
})
