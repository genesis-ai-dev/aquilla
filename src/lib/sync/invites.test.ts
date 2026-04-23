// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest"
import { createServerInvite, acceptServerInvite } from "./invites"

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
})

describe("acceptServerInvite", () => {
  afterEach(() => { global.fetch = originalFetch })

  it("POSTs token in body and returns the granted role", async () => {
    const fetchMock = mockFetch(200, { projectId: "proj-1", role: 400 })
    global.fetch = fetchMock as unknown as typeof fetch

    const result = await acceptServerInvite("jwt-user", "token-123", API)
    expect(result).toEqual({ projectId: "proj-1", role: 400 })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${API}/api/v2/projects/accept-invite`)
    expect(init!.method).toBe("POST")
    expect(JSON.parse(init!.body as string)).toEqual({ token: "token-123" })
  })

  it("returns null on 410 (used or expired)", async () => {
    global.fetch = mockFetch(410, { error: "expired" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "token", API)
    expect(result).toBeNull()
  })

  it("returns null on 404 (unknown token)", async () => {
    global.fetch = mockFetch(404, { error: "not found" }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "bogus", API)
    expect(result).toBeNull()
  })

  it("returns null on network error without throwing", async () => {
    global.fetch = vi.fn(async () => { throw new Error("offline") }) as unknown as typeof fetch
    const result = await acceptServerInvite("jwt", "t", API)
    expect(result).toBeNull()
  })
})
