// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { createServerInvite, acceptServerInvite, previewServerInvite, previewMultiInvite, acceptMultiInvite } from "./invites"

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

describe("createServerInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("POSTs with bearer + body, returns parsed response on success", async () => {
    const fetchMock = mockFetch(200, {
      token: "abc",
      projectId: "proj-1",
      role: 400,
      expiresAt: "2026-05-01T00:00:00Z",
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await createServerInvite("jwt-user", "proj-1", 400, API)
    expect(result).toEqual({
      token: "abc",
      projectId: "proj-1",
      role: 400,
      expiresAt: "2026-05-01T00:00:00Z",
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/proj-1/invites`)
    expect(init!.method).toBe("POST")
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer jwt-user")
    expect(JSON.parse(init!.body as string)).toEqual({ role: 400 })
  })

  it("URL-encodes projectId", async () => {
    const fetchMock = mockFetch(200, { token: "t", projectId: "p", role: 400, expiresAt: "x" })
    global.fetch = fetchMock as unknown as typeof fetch
    await createServerInvite("j", "proj with space", 400, API)
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/api/v2/projects/proj%20with%20space/invites`)
  })

  it("defaults role to 400 when omitted", async () => {
    const fetchMock = mockFetch(200, { token: "t", projectId: "p", role: 400, expiresAt: "x" })
    global.fetch = fetchMock as unknown as typeof fetch
    await createServerInvite("j", "p", undefined, API)
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as { role: number }
    expect(body.role).toBe(400)
  })

  it("returns null on 403 (caller not allowed)", async () => {
    global.fetch = mockFetch(403, { error: "not allowed" }) as unknown as typeof fetch
    const result = await createServerInvite("jwt", "proj-1", 400, API)
    expect(result).toBeNull()
  })

  it("returns null on network error without throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await createServerInvite("jwt", "proj-1", 400, API)
    expect(result).toBeNull()
  })

  it("includes email in request body when provided", async () => {
    const fetchMock = mockFetch(200, {
      token: "tok",
      projectId: "proj-1",
      role: 400,
      expiresAt: "x",
      email: "daniel@example.com",
    })
    global.fetch = fetchMock as unknown as typeof fetch
    const result = await createServerInvite(
      "jwt",
      "proj-1",
      400,
      API,
      "daniel@example.com"
    )
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as {
      role: number
      email?: string
    }
    expect(body.email).toBe("daniel@example.com")
    expect(result?.email).toBe("daniel@example.com")
  })

  it("trims whitespace and omits email when empty/whitespace", async () => {
    const fetchMock = mockFetch(200, { token: "t", projectId: "p", role: 400, expiresAt: "x" })
    global.fetch = fetchMock as unknown as typeof fetch
    await createServerInvite("j", "p", 400, API, "   ")
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty("email")
  })
})

describe("previewServerInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("returns {ok:true, data} on 200", async () => {
    const payload = { projectId: "p1", projectName: "Genesis", role: { level: 400, name: "contributor" }, expiresAt: null, email: null }
    global.fetch = mockFetch(200, payload) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: true, data: payload })
  })

  it("returns {ok:false, reason:'expired'} on 410 without code field (legacy server)", async () => {
    global.fetch = mockFetch(410, { error: "expired" }) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "expired" })
  })

  // AQU-429: server now returns code:'used' vs code:'time_expired' in the 410 body.
  it("returns {ok:false, reason:'used'} on 410 with code:'used'", async () => {
    global.fetch = mockFetch(410, { error: "Invite already used", code: "used" }) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "used" })
  })

  it("returns {ok:false, reason:'time_expired'} on 410 with code:'time_expired'", async () => {
    global.fetch = mockFetch(410, { error: "Invite expired", code: "time_expired" }) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "time_expired" })
  })

  it("returns {ok:false, reason:'invalid'} on 404", async () => {
    global.fetch = mockFetch(404, { error: "not found" }) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "invalid" })
  })

  it("returns {ok:false, reason:'network'} on fetch throw", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await previewServerInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "network" })
  })
})

describe("previewMultiInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("returns {ok:true, data} on 200", async () => {
    const payload = { token: "tok", role: { level: 400, name: "contributor" }, expiresAt: null, projects: [] }
    global.fetch = mockFetch(200, payload) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: true, data: payload })
  })

  // AQU-347: the Authorization header is what lets the server recognize the
  // original redeemer and answer 200 usedByCaller instead of 410 used. A bare
  // fetch here silently regresses the still-member re-click to a dead link.
  it("attaches Authorization when a jwt is provided (still-member re-click path)", async () => {
    const payload = { token: "tok", role: { level: 400, name: "contributor" }, expiresAt: null, projects: [{ projectId: "p1", projectName: "P", archived: false, usedByCaller: true }] }
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }))
    global.fetch = spy as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API, "jwt-abc")
    expect(result.ok).toBe(true)
    const init = spy.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer jwt-abc")
  })

  it("sends no Authorization header when jwt is absent (public preview unchanged)", async () => {
    const payload = { token: "tok", role: { level: 400, name: "contributor" }, expiresAt: null, projects: [] }
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(payload), { status: 200 }))
    global.fetch = spy as unknown as typeof fetch
    await previewMultiInvite("tok", API)
    const init = spy.mock.calls[0]?.[1]
    expect(new Headers(init?.headers ?? {}).get("Authorization")).toBeNull()
  })

  it("returns {ok:false, reason:'expired'} on 410 without code field (legacy server)", async () => {
    global.fetch = mockFetch(410, { error: "expired" }) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "expired" })
  })

  // AQU-429: server now returns code:'used' vs code:'time_expired' in the 410 body.
  it("returns {ok:false, reason:'used'} on 410 with code:'used'", async () => {
    global.fetch = mockFetch(410, { error: "Invite already used", code: "used" }) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "used" })
  })

  it("returns {ok:false, reason:'time_expired'} on 410 with code:'time_expired'", async () => {
    global.fetch = mockFetch(410, { error: "Invite expired", code: "time_expired" }) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "time_expired" })
  })

  it("returns {ok:false, reason:'invalid'} on 404", async () => {
    global.fetch = mockFetch(404, {}) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "invalid" })
  })

  it("returns {ok:false, reason:'network'} on fetch throw", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await previewMultiInvite("tok", API)
    expect(result).toEqual({ ok: false, reason: "network" })
  })
})

describe("acceptServerInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("POSTs token in body and returns the granted role", async () => {
    const fetchMock = mockFetch(200, { projectId: "proj-1", role: 400 })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await acceptServerInvite("jwt-user", "token-123", API)
    expect(result).toEqual({ ok: true, data: { projectId: "proj-1", role: 400 } })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/accept-invite`)
    expect(init!.method).toBe("POST")
    expect(JSON.parse(init!.body as string)).toEqual({ token: "token-123" })
  })

  it("returns {ok:false, reason:'used'} on 410 without a code field (legacy server)", async () => {
    global.fetch = mockFetch(410, { error: "expired" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "token", API)
    expect(result).toEqual({ ok: false, reason: "used" })
  })

  it("returns {ok:false, reason:'time_expired'} on 410 with code:'time_expired'", async () => {
    global.fetch = mockFetch(410, { error: "expired", code: "time_expired" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "token", API)
    expect(result).toEqual({ ok: false, reason: "time_expired" })
  })

  it("returns {ok:false, reason:'invalid'} on 404 (unknown token)", async () => {
    global.fetch = mockFetch(404, { error: "not found" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "bogus", API)
    expect(result).toEqual({ ok: false, reason: "invalid" })
  })

  // AQU-364: a 401 must NOT be classified the same as a dead invite — the
  // caller (JoinPage) uses this to distinguish "auth problem, re-prompt
  // sign-in" from "this link is really dead."
  it("returns {ok:false, reason:'unauthorized'} on 401 (not a dead-invite signal)", async () => {
    global.fetch = mockFetch(401, { error: "Invalid or expired token" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "token", API)
    expect(result).toEqual({ ok: false, reason: "unauthorized" })
  })

  it("returns {ok:false, reason:'wrong_email'} on 403", async () => {
    global.fetch = mockFetch(403, { error: "different email" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "token", API)
    expect(result).toEqual({ ok: false, reason: "wrong_email" })
  })

  it("returns {ok:false, reason:'network'} on network error without throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "t", API)
    expect(result).toEqual({ ok: false, reason: "network" })
  })
})

describe("acceptMultiInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("returns {ok:true, data} on 200", async () => {
    const payload = { token: "tok", accepted: [{ projectId: "p1", role: 400 }] }
    global.fetch = mockFetch(200, payload) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: true, data: payload })
  })

  // AQU-364: a 401 must NOT be classified the same as a dead invite.
  it("returns {ok:false, reason:'unauthorized'} on 401 (not a dead-invite signal)", async () => {
    global.fetch = mockFetch(401, { error: "Invalid or expired token" }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "unauthorized" })
  })

  it("returns {ok:false, reason:'wrong_email'} on 403", async () => {
    global.fetch = mockFetch(403, { error: "different email" }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "wrong_email" })
  })

  it("returns {ok:false, reason:'used'} on 410 with code:'used'", async () => {
    global.fetch = mockFetch(410, { error: "used", code: "used" }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "used" })
  })

  it("returns {ok:false, reason:'time_expired'} on 410 with code:'time_expired'", async () => {
    global.fetch = mockFetch(410, { error: "expired", code: "time_expired" }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "time_expired" })
  })

  it("returns {ok:false, reason:'invalid'} on 404", async () => {
    global.fetch = mockFetch(404, { error: "not found" }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "invalid" })
  })

  it("returns {ok:false, reason:'network'} on network error without throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await acceptMultiInvite("jwt", "tok", API)
    expect(result).toEqual({ ok: false, reason: "network" })
  })
})
