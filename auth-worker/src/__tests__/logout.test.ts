import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { jwtFor, authHeader } from "./helpers/db"

// [Pen test] Auth & session mgmt (2026-08-03): there was previously no
// server-side logout at all — the frontend only deleted the token locally,
// so a stolen/leaked access token kept authenticating for up to its full
// 30-day lifetime after the user logged out. These guard POST
// /api/v2/auth/logout, which denylists the caller's own token by `jti`
// (see utils/token-revocation.ts, migration 0073).

async function reqJson(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env,
  )
}

function register(username: string, email: string, password: string): Promise<Response> {
  return reqJson("/api/v2/auth/register", { username, email, password })
}

describe("POST /api/v2/auth/logout", () => {
  it("revokes the token used to call it — subsequent requests with it 401", async () => {
    await register("logout1", "logout1@example.com", "old-password-1")
    const login = await reqJson("/api/v2/auth/token", {
      username: "logout1",
      password: "old-password-1",
    })
    expect(login.status).toBe(200)
    const { access_token: token } = (await login.json()) as { access_token: string }

    const before = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(before.status).toBe(200)

    const logout = await app.request(
      "/api/v2/auth/logout",
      { method: "POST", headers: authHeader(token) },
      env,
    )
    expect(logout.status).toBe(200)

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: expect.stringContaining("revoked") })
  })

  it("does not affect a different, still-live token for the same account", async () => {
    await register("logout2", "logout2@example.com", "old-password-1")
    const first = await reqJson("/api/v2/auth/token", {
      username: "logout2",
      password: "old-password-1",
    })
    const { access_token: tokenA } = (await first.json()) as { access_token: string }
    const second = await reqJson("/api/v2/auth/token", {
      username: "logout2",
      password: "old-password-1",
    })
    const { access_token: tokenB } = (await second.json()) as { access_token: string }
    expect(tokenA).not.toBe(tokenB)

    await app.request("/api/v2/auth/logout", { method: "POST", headers: authHeader(tokenA) }, env)

    const revoked = await app.request("/api/v2/auth/me", { headers: authHeader(tokenA) }, env)
    expect(revoked.status).toBe(401)

    const stillLive = await app.request("/api/v2/auth/me", { headers: authHeader(tokenB) }, env)
    expect(stillLive.status).toBe(200)
  })

  it("a token minted with no jti (pre-existing token shape) is unaffected by the revocation check", async () => {
    await register("logout3", "logout3@example.com", "some-password-1")
    const legacyShapedToken = await jwtFor("logout3")

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(legacyShapedToken) }, env)
    expect(res.status).toBe(200)
  })

  it("requires authentication", async () => {
    const res = await app.request("/api/v2/auth/logout", { method: "POST" }, env)
    expect(res.status).toBe(401)
  })
})
