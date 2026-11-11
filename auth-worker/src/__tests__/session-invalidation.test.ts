import { env } from "cloudflare:test"
import { sign } from "hono/jwt"
import { JWTService } from "../auth/jwt"
import { seedUser } from "./helpers/db"
import { describe, it, expect } from "vitest"
import app from "../index"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { jwtFor, authHeader } from "./helpers/db"
import { clearSessionCache } from "../lib/session-cache"

// [Pen test] Auth & session mgmt (2026-07-20): a password reset previously
// did nothing to the access tokens already issued for the account — a
// stolen/leaked JWT kept authenticating for up to 30 more days (the default
// ACCESS_TOKEN_EXPIRE_MINUTES). These guard the fix: authMiddleware now
// rejects any token whose `iat` predates users.password_changed_at.

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

async function setPasswordChangedAt(username: string, iso: string): Promise<void> {
  // Written straight to the DB (= from another isolate). The session cache
  // would serve the pre-reset row until SESSION_CACHE_TTL_MS elapses — the
  // documented window (lib/session-cache.ts). Clearing models that; the
  // in-isolate eviction is covered in session-cache.test.ts.
  clearSessionCache()
  await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at = ? WHERE username = ?")
    .bind(iso, username)
    .run()
}

/** Plant a reset token in the shape the route actually writes: digest only
 *  (OPS-20/OPS-31). The plaintext is never stored, so a test that needs a
 *  usable token has to hash it in the same way the handler will. */
async function seedToken(username: string, token: string, expiresAt: string): Promise<void> {
  const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
  )
    .bind(u!.id, await sha256Hex(token), expiresAt)
    .run()
}

describe("password_changed_at floor on access-token validity", () => {
  it("rejects a token whose iat is before password_changed_at", async () => {
    await register("sess1", "sess1@example.com", "old-password-1")
    const iat = Math.floor(Date.now() / 1000) - 100
    const token = await jwtFor("sess1", iat)

    // No reset yet — token is valid.
    const before = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(before.status).toBe(200)

    // Reset stamped strictly after the token's iat (deterministic — no reliance
    // on wall-clock timing between minting the token and the assertion below).
    await setPasswordChangedAt("sess1", new Date((iat + 50) * 1000).toISOString())

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(after.status).toBe(401)
    expect(await after.json()).toMatchObject({ error: expect.stringContaining("password change") })
  })

  it("accepts a token whose iat is after password_changed_at", async () => {
    await register("sess2", "sess2@example.com", "old-password-1")
    const iat = Math.floor(Date.now() / 1000)
    await setPasswordChangedAt("sess2", new Date((iat - 100) * 1000).toISOString())
    const token = await jwtFor("sess2", iat)

    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
  })

  it("never having reset a password imposes no floor on token validity", async () => {
    await register("sess3", "sess3@example.com", "some-password-1")
    const token = await jwtFor("sess3")
    const res = await app.request("/api/v2/auth/me", { headers: authHeader(token) }, env)
    expect(res.status).toBe(200)
  })
})

describe("password-reset/reset end to end", () => {
  it("a token issued before the reset stops authenticating once the reset completes", async () => {
    await register("sess4", "sess4@example.com", "old-password-1")
    // iat in the past relative to the reset stamped below (CURRENT_TIMESTAMP at
    // request time) — avoids any same-second race with the real endpoint call,
    // while staying well inside the token's 1-hour exp window.
    const staleToken = await jwtFor("sess4", Math.floor(Date.now() / 1000) - 300)

    const preCheck = await app.request("/api/v2/auth/me", { headers: authHeader(staleToken) }, env)
    expect(preCheck.status).toBe(200)

    await seedToken("sess4", "resettoken-sess4", new Date(Date.now() + 3600_000).toISOString())
    const reset = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "resettoken-sess4",
      username: "sess4",
      new_password: "brand-new-pw-9",
    })
    expect(reset.status).toBe(200)

    const after = await app.request("/api/v2/auth/me", { headers: authHeader(staleToken) }, env)
    expect(after.status).toBe(401)

    const login = await reqJson("/api/v2/auth/token", { username: "sess4", password: "brand-new-pw-9" })
    expect(login.status).toBe(200)
    const { access_token: freshToken } = (await login.json()) as { access_token: string }
    const afterFresh = await app.request("/api/v2/auth/me", { headers: authHeader(freshToken) }, env)
    expect(afterFresh.status).toBe(200)
  })
})

// AQU-2530: real issuer → middleware → refresh, not a claims-only unit check.
it("never transfers old credentials to a recreated username, including legacy timestamps and refresh", async () => {
  await seedUser(71001, "reused")
  await env.AQUILLA_PG.prepare("UPDATE users SET created_at=now()-interval '1 day' WHERE id=71001").run()
  const jwt = new JWTService(env)
  const {token} = await jwt.createAccessTokenWithPayload("reused")
  const now = Math.floor(Date.now()/1000)
  const legacy = await sign({sub:"reused",iat:now,exp:now+3600}, env.SECRET_KEY,"HS256")
  for (const credential of [token, legacy]) {
    expect((await app.request("/api/v2/auth/me",{headers:authHeader(credential)},env)).status).toBe(200)
  }
  await env.AQUILLA_PG.prepare("DELETE FROM users WHERE id=71001").run()
  await seedUser(71002,"reused")
  // Force same-second replacement: rounding must not let a legacy token in.
  await env.AQUILLA_PG.prepare("UPDATE users SET created_at=? WHERE id=71002").bind(new Date(now*1000).toISOString()).run()
  await expect(jwt.createAccessTokenWithPayload("reused",undefined,undefined,71001)).rejects.toThrow("identity changed")
  clearSessionCache()
  for (const credential of [token, legacy]) {
    for (const path of ["me","refresh"]) {
      expect((await app.request(`/api/v2/auth/${path}`,{method:path==="refresh"?"POST":"GET",headers:authHeader(credential)},env)).status).toBe(401)
    }
  }
  const fresh = await jwt.createAccessToken("reused",undefined,71002)
  expect((await app.request("/api/v2/auth/me",{headers:authHeader(fresh)},env)).status).toBe(200)
  expect((await jwt.verifyToken(fresh))?.uid).toBe("71002")
})

it("uses expired credentials only as local ownership proof for an authenticated matching account", async () => {
  await seedUser(72001,"ownerproof")
  const service = new JWTService(env)
  const current = await service.createAccessToken("ownerproof")
  const old = {sub:"ownerproof",iat:1609459200,exp:1640995200}
  const endpoint = "/api/v2/auth/me/local-data-owner"
  expect((await app.request(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({previousToken:"x"})},env)).status).toBe(401)
  for (const [claims, secret, expected] of [
    [old,env.SECRET_KEY,true], [{...old,uid:"72001"},env.SECRET_KEY,true],
    [{...old,uid:"72002"},env.SECRET_KEY,false], [old,"not-the-secret",false],
    [{...old,sub:"another-user"},env.SECRET_KEY,false],
  ] as const) {
    const previousToken = await sign(claims,secret,"HS256")
    const res = await app.request(endpoint,{method:"POST",headers:authHeader(current),body:JSON.stringify({previousToken})},env)
    expect(await res.json()).toEqual({sameAccount:expected})
    expect((await app.request("/api/v2/auth/me",{headers:authHeader(previousToken)},env)).status).toBe(401)
  }
  await env.AQUILLA_PG.prepare("UPDATE users SET created_at=now() WHERE id=72001").run()
  clearSessionCache()
  const res = await app.request(endpoint,{method:"POST",headers:authHeader(current),body:JSON.stringify({previousToken:await sign(old,env.SECRET_KEY,"HS256")})},env)
  expect(await res.json()).toEqual({sameAccount:false})
})


it("rejects same-second legacy tokens and permits fresh versioned logins after reset", async () => {
  await seedUser(81801, "auditsecond")
  const iat = Math.floor(Date.now()/1000)-5
  const old = await jwtFor("auditsecond", iat)
  await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at=?, session_version=1 WHERE id=81801").bind(new Date(iat*1000+900).toISOString()).run()
  clearSessionCache()
  for (const path of ["me", "refresh"]) expect((await app.request(`/api/v2/auth/${path}`, { method:path==="refresh"?"POST":"GET", headers:authHeader(old) }, env)).status).toBe(401)
  const fresh = await new JWTService(env).createAccessToken("auditsecond")
  expect((await app.request("/api/v2/auth/me", {headers:authHeader(fresh)}, env)).status).toBe(200)
})

it("never renews a cached pre-reset session and fences a reset between validation and mint", async () => {
  await seedUser(81803,"auditcache")
  const now=Math.floor(Date.now()/1000)
  const token=await sign({sub:"auditcache",uid:"81803",sv:0,iat:now-7200,sst:now-7200,exp:now+60,jti:"cache-test"},env.SECRET_KEY,"HS256")
  expect((await app.request("/api/v2/auth/me",{headers:authHeader(token)},env)).status).toBe(200)
  // A different isolate cannot evict this instance's cache.
  await env.AQUILLA_PG.prepare("UPDATE users SET password_changed_at=now(), session_version=1 WHERE id=81803").run()
  expect((await app.request("/api/v2/auth/refresh",{method:"POST",headers:authHeader(token)},env)).status).toBe(401)
  await expect(new JWTService(env).createAccessTokenWithPayload("auditcache",now-7200,undefined,81803,0)).rejects.toThrow("Session invalidated")
  clearSessionCache()
  expect((await app.request("/api/v2/auth/me",{headers:authHeader(token)},env)).status).toBe(401)
  const fresh=await new JWTService(env).createAccessToken("auditcache")
  expect((await app.request("/api/v2/auth/me",{headers:authHeader(fresh)},env)).status).toBe(200)
})
