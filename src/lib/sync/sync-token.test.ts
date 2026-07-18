// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  fetchSyncToken,
  makeSyncTokenFetcher,
  SyncTokenError,
} from "./sync-token"

const API = "https://api.example.test"

function mockFetch(response: { status: number; body: unknown }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const bodyText =
      typeof response.body === "string" ? response.body : JSON.stringify(response.body)
    return new Response(bodyText, {
      status: response.status,
      headers: { "Content-Type": "application/json" },
      // attach what was sent so tests can inspect it
      // @ts-expect-error attaching for test inspection
      __probe: { url, init },
    }) as Response
  })
}

describe("fetchSyncToken", () => {
  const originalFetch = global.fetch
  afterEach(() => {
    global.fetch = originalFetch
  })

  it("POSTs to /api/v2/sync-token with bearer header and returns parsed response", async () => {
    const fetchMock = mockFetch({
      status: 200,
      body: {
        token: "jwt-abc",
        expiresIn: 900,
        role: { level: 400, name: "contributor", source: "override" },
      },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await fetchSyncToken("jwt-user", "proj-1", "file-a", {}, API)

    expect(result.token).toBe("jwt-abc")
    expect(result.expiresIn).toBe(900)
    expect(result.role).toEqual({ level: 400, name: "contributor", source: "override" })

    const call = fetchMock.mock.calls[0]
    expect(call[0]).toBe(`${API}/api/v2/sync-token`)
    const init = call[1]!
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer jwt-user")
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body as string)).toEqual({ projectId: "proj-1", fileId: "file-a" })
  })

  it("forwards projectName and gitlabProjectId when the bootstrap payload is set", async () => {
    const fetchMock = mockFetch({
      status: 200,
      body: { token: "t", expiresIn: 900, role: { level: 700, name: "owner", source: "creator" } },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await fetchSyncToken("jwt-user", "proj-1", "file-a", {
      projectName: "Genesis MVP",
      gitlabProjectId: 4242,
    }, API)

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body).toEqual({
      projectId: "proj-1",
      fileId: "file-a",
      projectName: "Genesis MVP",
      gitlabProjectId: 4242,
    })
  })

  it("omits bootstrap fields from the body when unset", async () => {
    const fetchMock = mockFetch({
      status: 200,
      body: { token: "t", expiresIn: 900, role: { level: 700, name: "owner", source: "creator" } },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    await fetchSyncToken("jwt-user", "proj-1", "file-a", undefined, API)

    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string)
    expect(body).toEqual({ projectId: "proj-1", fileId: "file-a" })
    expect(body).not.toHaveProperty("projectName")
    expect(body).not.toHaveProperty("gitlabProjectId")
  })

  it("throws SyncTokenError with status on non-2xx", async () => {
    global.fetch = mockFetch({ status: 403, body: { error: "no access" } }) as unknown as typeof fetch
    await expect(fetchSyncToken("jwt-user", "proj-x", "file-x", {}, API)).rejects.toMatchObject({
      name: "SyncTokenError",
      status: 403,
    })
  })

  it("handles 401 as SyncTokenError", async () => {
    global.fetch = mockFetch({ status: 401, body: "Authorization header required" }) as unknown as typeof fetch
    const err = await fetchSyncToken("bad", "p", "f", {}, API).catch((e) => e as SyncTokenError)
    expect(err).toBeInstanceOf(SyncTokenError)
    expect((err as SyncTokenError).status).toBe(401)
  })
})

describe("makeSyncTokenFetcher", () => {
  const originalFetch = global.fetch
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-21T12:00:00Z"))
  })
  afterEach(() => {
    global.fetch = originalFetch
    vi.useRealTimers()
  })

  it("returns null when no jwt is available", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch
    const getToken = makeSyncTokenFetcher(() => null, "proj-1", "file-a", {}, API)
    const result = await getToken()
    expect(result).toBeNull()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("caches the token and returns cached value before expiry", async () => {
    const fetchMock = mockFetch({
      status: 200,
      body: { token: "jwt-cached", expiresIn: 900, role: { level: 400, name: "contributor", source: "override" } },
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const getToken = makeSyncTokenFetcher(() => "jwt-user", "proj-1", "file-a", {}, API)
    expect(await getToken()).toBe("jwt-cached")
    expect(await getToken()).toBe("jwt-cached")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Advance to 10 min in — still 5 min of TTL remaining, so no refetch.
    vi.setSystemTime(new Date("2026-04-21T12:10:00Z"))
    expect(await getToken()).toBe("jwt-cached")
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("refreshes when within 30 s of expiry", async () => {
    const firstFetch = mockFetch({
      status: 200,
      body: { token: "jwt-first", expiresIn: 900, role: { level: 400, name: "contributor", source: "override" } },
    })
    global.fetch = firstFetch as unknown as typeof fetch

    const getToken = makeSyncTokenFetcher(() => "jwt-user", "proj-1", "file-a", {}, API)
    expect(await getToken()).toBe("jwt-first")

    // Jump to 14:45 — only 15 s of TTL left, inside the 30 s safety margin.
    vi.setSystemTime(new Date("2026-04-21T12:14:45Z"))

    const secondFetch = mockFetch({
      status: 200,
      body: { token: "jwt-second", expiresIn: 900, role: { level: 400, name: "contributor", source: "override" } },
    })
    global.fetch = secondFetch as unknown as typeof fetch

    expect(await getToken()).toBe("jwt-second")
    expect(secondFetch).toHaveBeenCalledTimes(1)
  })

  it("returns null and logs when the server rejects the jwt", async () => {
    global.fetch = mockFetch({ status: 401, body: "stale" }) as unknown as typeof fetch
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const getToken = makeSyncTokenFetcher(() => "stale-jwt", "proj-1", "file-a", {}, API)
    expect(await getToken()).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  // AQU-159 regression: a stale session JWT (401 from /sync-token) must fire
  // `onUnauthorized` exactly once and return null so the caller can redirect
  // to login — the user should never have to manually log out/in after a
  // backend migration (e.g. Postgres switch) invalidates stored tokens.
  it("AQU-159: fires onUnauthorized exactly once on 401 and returns null (no manual re-auth needed)", async () => {
    global.fetch = mockFetch({ status: 401, body: "Unauthorized" }) as unknown as typeof fetch
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const onUnauthorized = vi.fn()
    const getToken = makeSyncTokenFetcher(
      () => "expired-session-jwt",
      "proj-1",
      "file-a",
      {},
      API,
      { onUnauthorized },
    )

    // WHY: the user opened a project file after a backend migration. The stored
    // session JWT is invalid. The client must detect this (401) and call
    // `onUnauthorized` so the app can clear the session and redirect to login,
    // rather than silently failing and leaving the user stuck.
    const result = await getToken()
    expect(result).toBeNull()
    expect(onUnauthorized).toHaveBeenCalledTimes(1)

    // A second call (e.g. from a retry) fires the callback again — each call
    // that gets a 401 notifies the caller so it can act. The cache is cleared
    // on 401, so no stale cached token is returned.
    const result2 = await getToken()
    expect(result2).toBeNull()
    expect(onUnauthorized).toHaveBeenCalledTimes(2)
    ;(console.warn as ReturnType<typeof vi.spyOn>).mockRestore()
  })

  it("AQU-159: does NOT fire onUnauthorized on 403 (forbidden != stale token)", async () => {
    global.fetch = mockFetch({ status: 403, body: "Forbidden" }) as unknown as typeof fetch
    vi.spyOn(console, "warn").mockImplementation(() => undefined)

    const onUnauthorized = vi.fn()
    const onForbidden = vi.fn()
    const getToken = makeSyncTokenFetcher(
      () => "valid-but-no-access-jwt",
      "proj-archived",
      "file-a",
      {},
      API,
      { onUnauthorized, onForbidden },
    )

    await getToken()
    // WHY: 403 means the project is archived or the user has no access — that's
    // a different code path from a stale token. onForbidden fires, not onUnauthorized.
    expect(onForbidden).toHaveBeenCalledTimes(1)
    expect(onUnauthorized).not.toHaveBeenCalled()
    ;(console.warn as ReturnType<typeof vi.spyOn>).mockRestore()
  })
})
