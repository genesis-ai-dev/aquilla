import { describe, it, expect, vi, afterEach } from "vitest"
import {
  fetchMemberScopes,
  isInMemberScope,
  putMemberScopes,
  type MemberScope,
} from "./member-scopes"

const API = "https://api.example.com"

afterEach(() => vi.restoreAllMocks())

describe("fetchMemberScopes", () => {
  it("GETs the scopes endpoint with auth headers and returns parsed scopes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ scopes: [{ kind: "lane", value: "fr" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const got = await fetchMemberScopes("jwt-123", "proj-1", 42, API)
    expect(got).toEqual([{ kind: "lane", value: "fr" }])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/members/42/scopes`)
    expect(init?.method).toBeUndefined()
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
  })

  it("encodes projectId and userId in the URL", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ scopes: [] }), { status: 200 }),
    )
    await fetchMemberScopes("jwt", "proj with space", 7, API)
    const [url] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj%20with%20space/members/7/scopes`)
  })

  it("defaults to an empty array when scopes is absent", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toEqual([])
  })

  it("returns null on 403", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })

  it("returns null on 404", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 404 }))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })

  it("returns null on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    expect(await fetchMemberScopes("jwt", "p1", 1, API)).toBeNull()
  })
})

describe("putMemberScopes", () => {
  it("PUTs the replace-set with auth headers and JSON body, returns saved scopes", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ scopes: [{ kind: "file", value: "f1" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )
    const scopes: MemberScope[] = [{ kind: "file", value: "f1" }]
    const got = await putMemberScopes("jwt-123", "proj-1", 42, scopes, API)
    expect(got).toEqual([{ kind: "file", value: "f1" }])

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/members/42/scopes`)
    expect(init?.method).toBe("PUT")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt-123")
    expect((init?.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init?.body as string)).toEqual({ scopes })
  })

  it("returns [] when the server omits scopes on success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    )
    expect(await putMemberScopes("jwt", "p1", 1, [], API)).toEqual([])
  })

  it("throws with the server's error message on 400", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "scopes are for contributor/reviewer roles" }),
        { status: 400, headers: { "content-type": "application/json" } },
      ),
    )
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow(
      "scopes are for contributor/reviewer roles",
    )
  })

  it("throws with a generic HTTP status message when the error body isn't JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 403 }))
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow("HTTP 403")
  })

  it("propagates network errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"))
    await expect(putMemberScopes("jwt", "p1", 1, [], API)).rejects.toThrow("offline")
  })
})

const allowed = (scopes: MemberScope[], fileId = "file-1", lane = "fr") =>
  isInMemberScope(scopes, fileId, lane)

describe("isInMemberScope", () => {
  it("fails open when scopes are absent so the server remains authoritative", () => {
    expect(isInMemberScope(undefined, "file-1", "fr")).toBe(true)
    expect(isInMemberScope(null, "file-1", "fr")).toBe(true)
    expect(allowed([])).toBe(true)
  })

  it("requires the active lane to match one of the member's lane scopes", () => {
    const scopes: MemberScope[] = [
      { kind: "lane", value: "fr" },
      { kind: "lane", value: "es" },
    ]
    expect(allowed(scopes, "file-1", "fr")).toBe(true)
    expect(allowed(scopes, "file-1", "de")).toBe(false)
  })

  it("requires the file to match one of the member's file scopes", () => {
    const scopes: MemberScope[] = [
      { kind: "file", value: "file-1" },
      { kind: "file", value: "file-2" },
    ]
    expect(allowed(scopes, "file-2", "fr")).toBe(true)
    expect(allowed(scopes, "file-3", "fr")).toBe(false)
  })

  it("combines file and lane scope categories with AND semantics", () => {
    const scopes: MemberScope[] = [
      { kind: "file", value: "file-1" },
      { kind: "lane", value: "fr" },
    ]
    expect(allowed(scopes, "file-1", "fr")).toBe(true)
    expect(allowed(scopes, "file-2", "fr")).toBe(false)
    expect(allowed(scopes, "file-1", "es")).toBe(false)
  })
})
