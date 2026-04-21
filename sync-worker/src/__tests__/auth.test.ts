import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { verifyTokenForDoc, shouldBeReadOnly, type SyncTokenClaims } from "../auth"

const SECRET = "test-secret-key-for-unit-tests"

async function makeToken(partial: Partial<SyncTokenClaims> = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const claims: SyncTokenClaims = {
    userId: 42,
    projectId: "proj-1",
    fileId: "file-a",
    role: 400,
    aud: "sync",
    iat: now,
    exp: now + 900,
    ...partial,
  }
  return sign(claims as unknown as Record<string, unknown>, SECRET, "HS256")
}

describe("verifyTokenForDoc", () => {
  const expected = { projectId: "proj-1", fileId: "file-a" }

  it("accepts a valid token scoped to the right doc", async () => {
    const token = await makeToken()
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.claims.userId).toBe(42)
      expect(res.claims.role).toBe(400)
    }
  })

  it("rejects when SYNC_SECRET_KEY is not configured", async () => {
    const token = await makeToken()
    const res = await verifyTokenForDoc(token, expected, undefined)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(500)
      expect(res.reason).toContain("SYNC_SECRET_KEY")
    }
  })

  it("rejects when token is missing", async () => {
    const res = await verifyTokenForDoc(null, expected, SECRET)
    expect(res).toEqual({ ok: false, status: 401, reason: "missing token" })
  })

  it("rejects tokens signed with a different secret", async () => {
    const token = await sign(
      {
        userId: 42,
        projectId: "proj-1",
        fileId: "file-a",
        role: 400,
        aud: "sync",
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 900,
      } as Record<string, unknown>,
      "a-different-secret",
      "HS256"
    )
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.status).toBe(401)
  })

  it("rejects tokens without aud=sync (e.g. a frontier access token)", async () => {
    const token = await sign(
      { sub: "alice", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 } as Record<
        string,
        unknown
      >,
      SECRET,
      "HS256"
    )
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("wrong audience")
  })

  it("rejects expired tokens", async () => {
    const token = await makeToken({
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe("token expired")
  })

  it("rejects tokens scoped to a different project", async () => {
    const token = await makeToken({ projectId: "other-project" })
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.reason).toContain("different project")
    }
  })

  it("rejects tokens scoped to a different file", async () => {
    const token = await makeToken({ fileId: "other-file" })
    const res = await verifyTokenForDoc(token, expected, SECRET)
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.status).toBe(403)
      expect(res.reason).toContain("different file")
    }
  })
})

describe("shouldBeReadOnly", () => {
  // Ladder is 100 viewer / 200 commenter / 300 reviewer / 400 contributor /
  // 500 project_lead / 600 maintainer / 700 owner. Writes gate at 400.
  it("viewer, commenter, reviewer cannot write", () => {
    expect(shouldBeReadOnly(100)).toBe(true)
    expect(shouldBeReadOnly(200)).toBe(true)
    expect(shouldBeReadOnly(300)).toBe(true)
  })

  it("contributor and above can write", () => {
    expect(shouldBeReadOnly(400)).toBe(false)
    expect(shouldBeReadOnly(500)).toBe(false)
    expect(shouldBeReadOnly(600)).toBe(false)
    expect(shouldBeReadOnly(700)).toBe(false)
  })

  it("unknown role defaults to permissive (dev-mode fallback)", () => {
    expect(shouldBeReadOnly(null)).toBe(false)
    expect(shouldBeReadOnly(undefined)).toBe(false)
  })

  it("non-numeric / out-of-band role values stay gated when below threshold", () => {
    expect(shouldBeReadOnly(0)).toBe(true)
    expect(shouldBeReadOnly(399)).toBe(true)
  })
})
