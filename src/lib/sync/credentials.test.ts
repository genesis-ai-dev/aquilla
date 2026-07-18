// Tests for the credentials client lib (AQU-533 §1 "Token UI").
//
// WHY these tests matter: this is the only thing standing between the mint/
// revoke/list UI and the auth-worker credentials routes. If the request
// shape (method, headers, body) or error propagation drifts from the server
// contract (auth-worker/src/routes/credentials.ts), token minting silently
// breaks or — worse — a caller swallows a 403 and thinks a token was created.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { listCredentials, mintCredential, revokeCredential } from "./credentials"

const ORIG = global.fetch

beforeEach(() => {
  global.fetch = vi.fn()
})
afterEach(() => {
  global.fetch = ORIG
})

describe("listCredentials", () => {
  it("GETs /api/v2/credentials with the Authorization header and returns the list", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          credentials: [
            {
              id: "c1",
              name: "Import agent",
              mode: "ask",
              orgId: null,
              projectId: null,
              tokenPrefix: "aqk_abc123",
              createdAt: "2026-07-01T00:00:00.000Z",
              expiresAt: null,
              lastUsedAt: null,
              revokedAt: null,
            },
          ],
        }),
        { status: 200 },
      ),
    )

    const result = await listCredentials("test-jwt")

    expect(result).toHaveLength(1)
    expect(result[0].tokenPrefix).toBe("aqk_abc123")
    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(String(url)).toMatch(/\/api\/v2\/credentials$/)
    expect(init.headers.Authorization).toBe("Bearer test-jwt")
  })

  it("throws with the HTTP status on a non-OK response", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response("forbidden", { status: 403 }),
    )
    await expect(listCredentials("test-jwt")).rejects.toThrow(/403/)
  })
})

describe("mintCredential", () => {
  it("POSTs the mint payload as JSON with the Authorization header", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: "aqk_plaintexttoken",
          credential: {
            id: "c2",
            name: "Deploy bot",
            mode: "act",
            orgId: null,
            projectId: "proj-1",
            tokenPrefix: "aqk_plain",
            createdAt: "2026-07-01T00:00:00.000Z",
            expiresAt: null,
            lastUsedAt: null,
            revokedAt: null,
          },
        }),
        { status: 201 },
      ),
    )

    const result = await mintCredential("test-jwt", {
      name: "Deploy bot",
      mode: "act",
      projectId: "proj-1",
    })

    expect(result.token).toBe("aqk_plaintexttoken")
    expect(result.credential.projectId).toBe("proj-1")

    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(String(url)).toMatch(/\/api\/v2\/credentials$/)
    expect(init.method).toBe("POST")
    expect(init.headers.Authorization).toBe("Bearer test-jwt")
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(JSON.parse(init.body)).toEqual({
      name: "Deploy bot",
      mode: "act",
      projectId: "proj-1",
    })
  })

  it("propagates a scope_denied 403 as a thrown error rather than swallowing it", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "scope_denied" }), { status: 403 }),
    )
    await expect(
      mintCredential("test-jwt", { name: "x", mode: "act", projectId: "proj-1" }),
    ).rejects.toThrow(/403/)
  })
})

describe("revokeCredential", () => {
  it("DELETEs /api/v2/credentials/:id with the Authorization header", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await revokeCredential("test-jwt", "c1")

    const [url, init] = (global.fetch as any).mock.calls[0]
    expect(String(url)).toMatch(/\/api\/v2\/credentials\/c1$/)
    expect(init.method).toBe("DELETE")
    expect(init.headers.Authorization).toBe("Bearer test-jwt")
  })

  it("throws on a non-OK response", async () => {
    ;(global.fetch as any).mockResolvedValueOnce(new Response("not found", { status: 404 }))
    await expect(revokeCredential("test-jwt", "missing")).rejects.toThrow(/404/)
  })
})
