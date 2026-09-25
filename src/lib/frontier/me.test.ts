import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { fetchMyUserId, resetMyUserIdCache } from "./me"

// AQU-1029: resolving the caller's own numeric id WITHOUT the project roster,
// so a lane-scoped contributor (whom `rosterViewMinRole` 403s) can still read
// their own scopes.
describe("fetchMyUserId", () => {
  const API = "https://auth.test"

  beforeEach(() => {
    resetMyUserIdCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    resetMyUserIdCache()
  })

  function stubFetch(impl: (_url: string, init?: RequestInit) => Promise<Response> | Response) {
    const spy = vi.fn(impl)
    vi.stubGlobal("fetch", spy as unknown as typeof fetch)
    return spy
  }

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } })

  it("returns the numeric id from GET /auth/me", async () => {
    const spy = stubFetch(() => ok({ id: 1220, username: "qa-bot-2" }))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBe(1220)
    expect(spy).toHaveBeenCalledWith(`${API}/api/v2/auth/me`, {
      headers: { Authorization: "Bearer jwt-a" },
    })
  })

  it("THE REGRESSION: it never touches the roster, so a 403-roster member still resolves", async () => {
    // The whole point: /auth/me is behind plain auth, not the project's
    // rosterViewMinRole policy. Exactly one request, and it is /auth/me.
    const spy = stubFetch(() => ok({ id: 7 }))
    await fetchMyUserId("jwt-a", API)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain("/api/v2/auth/me")
    expect(String(spy.mock.calls[0][0])).not.toContain("/members")
  })

  it("returns null on a non-2xx rather than throwing", async () => {
    stubFetch(() => new Response("nope", { status: 401 }))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
  })

  it("returns null on a network error rather than throwing", async () => {
    stubFetch(() => Promise.reject(new Error("offline")))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
  })

  it("returns null when the body carries no numeric id", async () => {
    stubFetch(() => ok({ username: "someone" }))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
    resetMyUserIdCache()
    stubFetch(() => ok({ id: "1220" }))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
  })

  it("memoizes per JWT so a cold project open issues one request, not one per hook", async () => {
    const spy = stubFetch(() => ok({ id: 42 }))
    const [a, b, c] = await Promise.all([
      fetchMyUserId("jwt-a", API),
      fetchMyUserId("jwt-a", API),
      fetchMyUserId("jwt-a", API),
    ])
    expect([a, b, c]).toEqual([42, 42, 42])
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it("keys the memo by JWT so an account switch re-resolves", async () => {
    const spy = stubFetch((_url, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization
      return ok({ id: auth === "Bearer jwt-a" ? 1 : 2 })
    })
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBe(1)
    await expect(fetchMyUserId("jwt-b", API)).resolves.toBe(2)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it("caches a failure instead of retry-looping", async () => {
    const spy = stubFetch(() => new Response("", { status: 500 }))
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
    await expect(fetchMyUserId("jwt-a", API)).resolves.toBeNull()
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
