import { describe, it, expect } from "vitest"
import { sign } from "hono/jwt"
import { JWTService } from "../auth/jwt"
import type { Env } from "../types"

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_DB: {} as unknown as D1Database,
    SECRET_KEY: "test-secret",
    ALGORITHM: "HS256",
    ACCESS_TOKEN_EXPIRE_MINUTES: "60",
    ...overrides,
  }
}

describe("JWTService.createAccessToken / verifyToken", () => {
  it("round-trips a token signed with HS256", async () => {
    const env = makeEnv()
    const svc = new JWTService(env)
    const token = await svc.createAccessToken("alice")
    const payload = await svc.verifyToken(token)
    expect(payload).not.toBeNull()
    expect(payload?.sub).toBe("alice")
    expect(typeof payload?.exp).toBe("number")
  })

  it("rejects tokens signed with a different secret", async () => {
    const env = makeEnv()
    const svc = new JWTService(env)
    const fake = await sign(
      { sub: "alice", iat: 0, exp: Math.floor(Date.now() / 1000) + 60 },
      "different-secret",
      "HS256",
    )
    expect(await svc.verifyToken(fake)).toBeNull()
  })

  it("returns null when SECRET_KEY is missing", async () => {
    const svc = new JWTService(makeEnv({ SECRET_KEY: "" }))
    const fake = await sign(
      { sub: "alice", iat: 0, exp: Math.floor(Date.now() / 1000) + 60 },
      "anything",
      "HS256",
    )
    expect(await svc.verifyToken(fake)).toBeNull()
  })

  it("throws when signing without a configured secret", async () => {
    const svc = new JWTService(makeEnv({ SECRET_KEY: "" }))
    await expect(svc.createAccessToken("alice")).rejects.toThrow(/SECRET_KEY/)
  })
})

describe("JWTService.extractTokenFromHeader", () => {
  const svc = new JWTService(makeEnv())

  it("accepts the canonical Bearer scheme", () => {
    expect(svc.extractTokenFromHeader("Bearer abc.def.ghi")).toBe("abc.def.ghi")
  })

  it("accepts a bare JWT", () => {
    expect(svc.extractTokenFromHeader("abc.def.ghi")).toBe("abc.def.ghi")
  })

  it("accepts a non-standard scheme containing a JWT-shaped segment", () => {
    expect(svc.extractTokenFromHeader("token abc.def.ghi")).toBe("abc.def.ghi")
  })

  it("returns null when the header is empty or junk", () => {
    expect(svc.extractTokenFromHeader(null)).toBeNull()
    expect(svc.extractTokenFromHeader("")).toBeNull()
    expect(svc.extractTokenFromHeader("Basic dXNlcjpwdw==")).toBeNull()
  })
})
