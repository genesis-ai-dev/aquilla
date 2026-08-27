// AQU-995: the stored JWT must roll forward while the session is in use, so a
// fixed 30-day token never lapses under someone actively translating. The
// regression these guard: nothing on the client looked at `exp`, so the first
// sign of expiry was a request failing mid-edit.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import "fake-indexeddb/auto"
import { jwtLifetime, refreshActiveSession, shouldRefreshJwt } from "./session-refresh"
import { clearSession, loadActiveSession, saveSession } from "./session-store"

const LIFETIME = 30 * 24 * 60 * 60

/** Unsigned JWT-shaped token — the client only ever decodes, never verifies. */
function tokenWith(claims: Record<string, unknown>): string {
  const encode = (o: unknown) =>
    btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  return `${encode({ alg: "HS256" })}.${encode(claims)}.sig`
}

/** Token aged `ageSeconds` into a 30-day lifetime. */
function aged(ageSeconds: number, sub = "anna"): string {
  const iat = Math.floor(Date.now() / 1000) - ageSeconds
  return tokenWith({ sub, iat, exp: iat + LIFETIME })
}

beforeEach(async () => {
  await clearSession()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("jwtLifetime", () => {
  it("reads iat/exp out of the payload", () => {
    expect(jwtLifetime(tokenWith({ iat: 10, exp: 70 }))).toEqual({ iat: 10, exp: 70 })
  })

  it("returns null when the answer isn't knowable", () => {
    expect(jwtLifetime(null)).toBeNull()
    expect(jwtLifetime("not-a-jwt")).toBeNull()
    expect(jwtLifetime(tokenWith({ sub: "anna" }))).toBeNull()
    expect(jwtLifetime(tokenWith({ iat: 10, exp: "soon" }))).toBeNull()
  })
})

describe("shouldRefreshJwt", () => {
  it("is false in the first half of the token's life", () => {
    expect(shouldRefreshJwt(aged(LIFETIME * 0.25))).toBe(false)
  })

  it("is true from the half-way point until expiry", () => {
    expect(shouldRefreshJwt(aged(LIFETIME * 0.5))).toBe(true)
    expect(shouldRefreshJwt(aged(LIFETIME * 0.99))).toBe(true)
  })

  it("stops asking once the token has lapsed — a dead token can't be refreshed", () => {
    expect(shouldRefreshJwt(aged(LIFETIME * 1.5))).toBe(false)
  })

  it("is false when expiry can't be determined", () => {
    expect(shouldRefreshJwt(null)).toBe(false)
    expect(shouldRefreshJwt("garbage")).toBe(false)
  })
})

describe("refreshActiveSession", () => {
  it("swaps in the new token when one is due", async () => {
    const old = aged(LIFETIME * 0.75)
    const next = aged(0)
    await saveSession({ jwt: old, username: "anna", createdAt: "2026-01-01", email: "a@x.dev" })

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: next, refreshed: true }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    expect(await refreshActiveSession()).toBe(true)
    const stored = await loadActiveSession()
    expect(stored?.jwt).toBe(next)
    // Everything else about the account survives the swap.
    expect(stored?.username).toBe("anna")
    expect(stored?.email).toBe("a@x.dev")
  })

  it("makes no request at all while the token is still young", async () => {
    await saveSession({ jwt: aged(60), username: "anna", createdAt: "2026-01-01" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    expect(await refreshActiveSession()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("makes no request for an already-expired token — that's the 401 loop we're removing", async () => {
    await saveSession({ jwt: aged(LIFETIME * 2), username: "anna", createdAt: "2026-01-01" })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    expect(await refreshActiveSession()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does nothing when no session is stored", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    expect(await refreshActiveSession()).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("leaves the stored session untouched when the server declines", async () => {
    const old = aged(LIFETIME * 0.75)
    await saveSession({ jwt: old, username: "anna", createdAt: "2026-01-01" })
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 401 })))

    expect(await refreshActiveSession()).toBe(false)
    expect((await loadActiveSession())?.jwt).toBe(old)
  })

  it("leaves the stored session untouched when offline", async () => {
    const old = aged(LIFETIME * 0.75)
    await saveSession({ jwt: old, username: "anna", createdAt: "2026-01-01" })
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))

    expect(await refreshActiveSession()).toBe(false)
    expect((await loadActiveSession())?.jwt).toBe(old)
  })

  it("reports no swap when the server echoes the same token back", async () => {
    const old = aged(LIFETIME * 0.75)
    await saveSession({ jwt: old, username: "anna", createdAt: "2026-01-01" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: old, refreshed: false }), { status: 200 }),
      ),
    )

    expect(await refreshActiveSession()).toBe(false)
    expect((await loadActiveSession())?.jwt).toBe(old)
  })

  it("does not clobber a credential that changed while the request was in flight", async () => {
    const old = aged(LIFETIME * 0.75)
    const reLogin = aged(0, "anna")
    const stale = aged(0, "anna")
    await saveSession({ jwt: old, username: "anna", createdAt: "2026-01-01" })

    // The user re-authenticates (or switches accounts) mid-request.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await saveSession({ jwt: reLogin, username: "anna", createdAt: "2026-02-01" })
        return new Response(JSON.stringify({ access_token: stale }), { status: 200 })
      }),
    )

    expect(await refreshActiveSession()).toBe(false)
    expect((await loadActiveSession())?.jwt).toBe(reLogin)
  })

  it("de-dupes concurrent triggers into a single request", async () => {
    await saveSession({ jwt: aged(LIFETIME * 0.75), username: "anna", createdAt: "2026-01-01" })
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ access_token: aged(0) }), { status: 200 }),
    )
    vi.stubGlobal("fetch", fetchMock)

    // Mount, visibilitychange and the interval can all land in the same tick.
    const results = await Promise.all([
      refreshActiveSession(),
      refreshActiveSession(),
      refreshActiveSession(),
    ])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results).toEqual([true, true, true])
  })
})
