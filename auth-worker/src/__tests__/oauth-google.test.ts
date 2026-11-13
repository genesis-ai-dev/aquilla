import { URL as NodeURL } from "node:url"
import { readFileSync } from "node:fs"
import { PGlite } from "@electric-sql/pglite"
import { env } from "cloudflare:test"
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { generateKeyPair, exportJWK, SignJWT } from "jose"
import app from "../index"
import { JWTService } from "../auth/jwt"
import { pkceChallenge } from "../routes/oauth-google"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import * as legacy from "../services/frontier-d1"
import { ipIdentifier } from "../utils/rate-limit"
import * as postResponse from "../lib/post-response-db"
import { seedUser } from "./helpers/db"
const origin = "https://app.example.com", verifier = "a".repeat(64)
const testEnv = Object.assign(Object.create(env), { GOOGLE_LOGIN_CLIENT_ID: "test-client", GOOGLE_LOGIN_CLIENT_SECRET: "test-secret", GOOGLE_LOGIN_REDIRECT_URI: "https://identity.example.com/api/v2/auth/oauth/google/callback", GOOGLE_LOGIN_APP_ORIGINS: origin })
let keys: Awaited<ReturnType<typeof generateKeyPair>>, jwk: object, token: string
const network = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  // These tests run in Node; assert the Workers-compatible no-follow contract.
  const request = new Request(input, init)
  const url = request.url
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [jwk] })
  if (url === "https://oauth2.googleapis.com/token") {
    expect(request.redirect).toBe("manual")
    return Response.json({ id_token: token, access_token: "never-store-this" })
  }
  throw new Error("Unexpected network destination")
})
beforeAll(async () => { keys = await generateKeyPair("RS256"); jwk = { ...await exportJWK(keys.publicKey), kid: "test", alg: "RS256", use: "sig" } })
beforeEach(() => { network.mockClear(); vi.stubGlobal("fetch", network) })
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const key of ["DEPLOYMENT_WORKER_NAME", "DEV_ACCESS_LIST", "LEGACY_USER_MIGRATION_ENABLED", "FRONTIER_D1_ACCOUNT_ID", "FRONTIER_D1_DATABASE_ID", "FRONTIER_D1_API_TOKEN"]) delete testEnv[key] })
const post = (path: string, body: object, originHeader = origin) => app.request(`/api/v2/auth/oauth/google/${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: originHeader }, body: JSON.stringify(body) }, testEnv)
async function start() {
  const res = await post("start", { challenge: await pkceChallenge(verifier) })
  expect(res.status).toBe(200)
  return new URL((await res.json() as { authorization_url: string }).authorization_url)
}
async function callback(url: URL, claims: Record<string, unknown> = {}) {
  token = await new SignJWT({ nonce: url.searchParams.get("nonce"), email: "alice@example.com", email_verified: true, hd: "example.com", iss: "https://accounts.google.com", aud: "test-client", sub: "google-alice", iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000)+300, ...claims }).setProtectedHeader({ alg: "RS256", kid: "test" }).sign(keys.privateKey)
  return app.request(`/api/v2/auth/oauth/google/callback?state=${url.searchParams.get("state")}&code=provider-code`, {}, testEnv)
}
async function handoff() {
  const response = await callback(await start())
  expect(response.status).toBe(303)
  const location = new URL(response.headers.get("location")!)
  expect(location.origin).toBe(origin)
  expect(location.search).toBe("")
  const code = new URLSearchParams(location.hash.slice(1)).get("code")!
  expect(code).toMatch(/^[a-f0-9]{64}$/)
  return code
}
describe("Google login boundary", () => {
  it("refuses a legacy Google link whose email no longer matches the account", async () => {
    await seedUser(1,"alice")
    await env.AQUILLA_PG.prepare("INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','google-alice',1)").run()
    await env.AQUILLA_PG.prepare("UPDATE users SET email='changed@example.com',password_hash=NULL WHERE id=1").run()
    const response = await post("exchange",{code:await handoff(),verifier})
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({error:"account_mismatch"})
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int n FROM users").first()).toEqual({n:1})
  })

  it("revokes pending and fresh old-Google access after a verified email change", async () => {
    await seedUser(1,"alice")
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1").bind(await hashPasswordWerkzeugScrypt("a strong password")).run()
    await env.AQUILLA_PG.prepare("INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','google-alice',1)").run()
    const pendingCode=await handoff()
    const jwt=await new JWTService(testEnv).createAccessToken("alice")
    let mail=""
    const mailEnv=Object.assign(Object.create(testEnv),{EMAIL:{send:async (m:{text:string})=>{mail=m.text}}})
    const change=(path:string,body:object)=>app.request("/api/v2/auth/email-change/"+path,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${jwt}`},body:JSON.stringify(body)},mailEnv)
    expect((await change("request",{email:"new@example.com",password:"a strong password"})).status).toBe(200)
    expect((await change("confirm",{token:mail.match(/\b[0-9]{6}\b/)![0]})).status).toBe(200)
    expect((await post("exchange",{code:pendingCode,verifier})).status).toBe(400)
    const fresh=await (await post("exchange",{code:await handoff(),verifier})).json() as {step:string;access_token?:string;continuation:string}
    expect(fresh.step).toBe("signup")
    expect(fresh.access_token).toBeUndefined()
    // The old Google identity cannot reclaim the existing username/account.
    expect((await post("finish",{code:fresh.continuation,verifier,username:"alice"})).status).toBe(409)
    expect(await env.AQUILLA_PG.prepare("SELECT email FROM users WHERE id=1").first()).toEqual({email:"new@example.com"})
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int n FROM provider_identities WHERE user_id=1").first()).toEqual({n:0})
  })

  it.each(["connect", "finish"])("refuses an old %s proof if email changes while waiting for the account lock", async path => {
    await seedUser(1,"alice")
    const password="a strong password"
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1").bind(await hashPasswordWerkzeugScrypt(password)).run()
    const jwt=await new JWTService(testEnv).createAccessToken("alice")
    let code=await handoff()
    if(path==="finish") code=(await (await post("exchange",{code,verifier})).json() as {continuation:string}).continuation
    const transact=env.AQUILLA_PG.transaction!.bind(env.AQUILLA_PG)
    vi.spyOn(env.AQUILLA_PG,"transaction").mockImplementationOnce(async work => {
      // A concurrent email-change commit lands after password proof was read.
      await env.AQUILLA_PG.prepare("UPDATE users SET email='new@example.com',session_version=session_version+1 WHERE id=1").run()
      return transact(work)
    })
    const response=await app.request("/api/v2/auth/oauth/google/"+path,{method:"POST",headers:{"Content-Type":"application/json",Authorization:`Bearer ${jwt}`},body:JSON.stringify({code,verifier,password})},testEnv)
    expect(response.status).toBe(409)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int n FROM provider_identities WHERE user_id=1").first()).toEqual({n:0})
  })

  it("does not mint a replacement session if email changes during Google exchange", async () => {
    await seedUser(1,"alice")
    await env.AQUILLA_PG.prepare("INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','google-alice',1)").run()
    const original=JWTService.prototype.createAccessTokenWithPayload
    vi.spyOn(JWTService.prototype,"createAccessTokenWithPayload").mockImplementationOnce(async function(this: JWTService, ...args) {
      await env.AQUILLA_PG.prepare("UPDATE users SET email='new@example.com',session_version=session_version+1 WHERE id=1").run()
      await env.AQUILLA_PG.prepare("DELETE FROM provider_identities WHERE user_id=1").run()
      return original.apply(this,args)
    })
    const response=await post("exchange",{code:await handoff(),verifier})
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({error:"session_failed"})
  })

  it("writes welcome verification using the task-owned database handle", async () => {
    const original = postResponse.withPostResponseDb
    const close = vi.fn(async () => {})
    const prepare = vi.fn(env.AQUILLA_PG.prepare.bind(env.AQUILLA_PG))
    const ownDb = new Proxy(env.AQUILLA_PG,{get(target,key) { return key === "prepare" ? prepare : Reflect.get(target,key) }})
    const task = vi.spyOn(postResponse,"withPostResponseDb").mockImplementation((taskEnv,work) => original(taskEnv,work,() => ({db:ownDb,close})))
    const response = await callback(await start(),{hd:undefined})
    const code = new URLSearchParams(new URL(response.headers.get("location")!).hash.slice(1)).get("code")!
    const pending = await (await post("exchange",{code,verifier})).json() as {continuation:string}
    expect((await post("finish",{code:pending.continuation,verifier,username:"alice"})).status).toBe(200)
    expect(task).toHaveBeenCalledOnce()
    expect(prepare.mock.calls.some(([sql]) => sql.includes("INSERT INTO email_verification_tokens"))).toBe(true)
    expect(close).toHaveBeenCalledOnce()
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM email_verification_tokens").first()).toEqual({n:1})
  })

  it("reports post-commit session failure accurately and recovers with a fresh Google login", async () => {
    const pending = await (await post("exchange", {code:await handoff(),verifier})).json() as {continuation:string}
    const mint = vi.spyOn(JWTService.prototype,"createAccessTokenWithPayload").mockRejectedValueOnce(new Error("signer unavailable"))
    const failed = await post("finish",{code:pending.continuation,verifier,username:"alice"})
    expect(failed.status).toBe(503)
    expect(await failed.json()).toEqual({error:"session_failed"})
    expect(await env.AQUILLA_PG.prepare("SELECT username FROM users").first()).toEqual({username:"alice"})
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM provider_identities").first()).toEqual({n:1})
    mint.mockRestore()
    const recovered = await post("exchange",{code:await handoff(),verifier})
    expect(recovered.status).toBe(200)
    const body = await recovered.json() as {access_token:string;created:boolean}
    expect(body.created).toBe(false)
    expect((await app.request("/api/v2/auth/me",{headers:{Authorization:`Bearer ${body.access_token}`}},testEnv)).status).toBe(200)
    expect((await post("finish",{code:pending.continuation,verifier,username:"alice"})).status).toBe(400)
  })

  it.each([true,false])("persists explicit Google-signup sharing only for the newly authenticated account: %s", async allowed => {
    await seedUser(900,"other")
    const pending = await (await post("exchange",{code:await handoff(),verifier})).json() as {continuation:string}
    const result = await (await post("finish",{code:pending.continuation,verifier,username:"alice"})).json() as {access_token:string}
    const headers = {Authorization:`Bearer ${result.access_token}`,"Content-Type":"application/json"}
    const endpoint = "/api/v2/auth/me/analytics-consent"
    expect(await (await app.request(endpoint,{headers},testEnv)).json()).toMatchObject({decision:null})
    const { ANALYTICS_DISCLOSURE_VERSION } = await import("../../../shared/analytics-consent")
    const saved = await app.request(endpoint,{method:"PUT",headers,body:JSON.stringify({allowed,source:"signup",disclosureVersion:ANALYTICS_DISCLOSURE_VERSION,expectedRevision:null})},testEnv)
    expect(saved.status).toBe(200)
    expect(await (await app.request(endpoint,{headers},testEnv)).json()).toMatchObject({decision:{allowed,source:"signup"}})
    expect(await env.AQUILLA_PG.prepare("SELECT preferences FROM users WHERE id=900").first()).toEqual({preferences:"{}"})
  })

  it("refuses provider navigation when the database is incompatible, and recovers after repair", async () => {
    expect((await app.request("/api/v2/auth/oauth/google/config",{},testEnv)).status).toBe(200)
    await env.AQUILLA_PG.prepare("ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL").run()
    try {
      expect((await app.request("/api/v2/auth/oauth/google/config",{},testEnv)).status).toBe(503)
      expect((await post("start",{challenge:await pkceChallenge(verifier)})).status).toBe(503)
      expect(network).not.toHaveBeenCalled()
      expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM social_login_flows").first()).toEqual({n:0})
    } finally { await env.AQUILLA_PG.prepare("ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL").run() }
    expect((await post("start",{challenge:await pkceChallenge(verifier)})).status).toBe(200)
  })

  it("manages only the authenticated account, requires password proof and never contacts Google for status or disconnect", async () => {
    await seedUser(1, "alice")
    await seedUser(2, "bob")
    const password = "test-password-123"
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1").bind(await hashPasswordWerkzeugScrypt(password)).run()
    const jwt = (await new JWTService(testEnv).createAccessTokenWithPayload("alice")).token
    const bobJwt = (await new JWTService(testEnv).createAccessTokenWithPayload("bob")).token
    const manage = (path: string, body?: object, bearer = jwt) => app.request(`/api/v2/auth/oauth/google/${path}`, {
      method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, testEnv)
    expect((await manage("methods", undefined, "invalid")).status).toBe(401)
    expect(await (await manage("methods")).json()).toMatchObject({ password: true, google: false })
    expect(network).not.toHaveBeenCalled()
    const code = await handoff()
    expect((await manage("connect", { code, verifier, password: "wrong" })).status).toBe(401)
    expect((await manage("connect", { code, verifier, password })).status).toBe(200)
    expect(await (await manage("methods")).json()).toMatchObject({ google: true })
    expect(await (await manage("methods", undefined, bobJwt)).json()).toMatchObject({ google: false })
    network.mockClear()
    expect((await manage("disconnect", { password: "wrong" })).status).toBe(401)
    expect(await env.AQUILLA_PG.prepare("SELECT user_id FROM provider_identities").first()).toEqual({ user_id: 1 })
    expect((await manage("disconnect", { password })).status).toBe(200)
    expect(await (await manage("methods")).json()).toMatchObject({ password: true, google: false })
    expect(network).not.toHaveBeenCalled()
  })
  it("refuses mismatched Google identities and removal of the last login method", async () => {
    await seedUser(1, "bob")
    const password = "test-password-123"
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1").bind(await hashPasswordWerkzeugScrypt(password)).run()
    const jwt = (await new JWTService(testEnv).createAccessTokenWithPayload("bob")).token
    const manage = (path: string, body: object) => app.request(`/api/v2/auth/oauth/google/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    }, testEnv)
    expect((await manage("connect", { code: await handoff(), verifier, password })).status).toBe(409)
    expect(await env.AQUILLA_PG.prepare("SELECT * FROM provider_identities").first()).toBeNull()
    await env.AQUILLA_PG.prepare("INSERT INTO provider_identities(provider,subject,user_id) VALUES ('google','google-bob',1)").run()
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=NULL WHERE id=1").run()
    expect((await manage("disconnect", { password })).status).toBe(409)
    expect(await env.AQUILLA_PG.prepare("SELECT user_id FROM provider_identities").first()).toEqual({ user_id: 1 })
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1").bind(await hashPasswordWerkzeugScrypt(password)).run()
    expect((await manage("disconnect", { password })).status).toBe(200)
  })

  it.each(["aquilla-dev-identity", "aquilla-auth-preview"])("enforces access on %s before signup and linked login, including revocation between steps", async (worker) => {
    testEnv.DEPLOYMENT_WORKER_NAME = worker
    const get = vi.fn().mockResolvedValue(null)
    testEnv.DEV_ACCESS_LIST = { get } as unknown as KVNamespace
    const denied = await post("exchange", { code: await handoff(), verifier })
    expect(denied.status).toBe(403)
    expect(await denied.json()).toMatchObject({ code: "dev_access_restricted" })
    expect(await env.AQUILLA_PG.prepare("SELECT id FROM users").first()).toBeNull()
    get.mockResolvedValue("{}")
    const pending = await (await post("exchange", { code: await handoff(), verifier })).json() as { continuation: string }
    get.mockResolvedValue(null)
    const body = { code: pending.continuation, verifier, username: "alice" }
    expect((await post("finish", body)).status).toBe(403)
    expect(await env.AQUILLA_PG.prepare("SELECT id FROM users").first()).toBeNull()
    get.mockResolvedValue("{}")
    expect((await post("finish", body)).status).toBe(200)
    get.mockResolvedValue(null)
    expect((await post("exchange", { code: await handoff(), verifier })).status).toBe(403)
    get.mockRejectedValue(new Error("KV unavailable"))
    expect((await post("exchange", { code: await handoff(), verifier })).status).toBe(503)
  })

  it("diagnoses provider failures without logging credentials or provider response bodies", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    for (const failure of ["rejected", "redirected", "network"] as const) {
      const url = await start()
      network.mockImplementationOnce(async () => {
        if (failure === "network") throw new Error("private-token-and-client-secret")
        if (failure === "redirected") return new Response(null, { status: 302, headers: { Location: "https://attacker.example" } })
        return Response.json({ error: "invalid_client", error_description: "private-token-and-client-secret" }, { status: 401 })
      })
      expect((await callback(url)).headers.get("location")).toContain("error=provider_failed")
    }
    expect(warn.mock.calls).toEqual([
      ["[social-login] token exchange rejected", 401],
      ["[social-login] token exchange rejected", 302],
      ["[social-login] callback failed", "token_exchange"],
    ])
  })
  it("is first-party only before redirect, uses minimal scopes and refuses untrusted return origins", async () => {
    const disabled = await app.request("/api/v2/auth/oauth/google/config", {}, env)
    expect(await disabled.json()).toEqual({ enabled: false })
    expect((await app.request("/api/v2/auth/oauth/google/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ challenge: await pkceChallenge(verifier) }) }, env)).status).toBe(503)
    const url = await start()
    expect(network).not.toHaveBeenCalled()
    expect(url.origin).toBe("https://accounts.google.com")
    expect(url.searchParams.get("scope")).toBe("openid email")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.has("login_hint")).toBe(false)
    expect((await post("start", { challenge: await pkceChallenge(verifier) }, "https://attacker.example")).status).toBe(400)
    const stored = await env.AQUILLA_PG.prepare("SELECT state_hash FROM social_login_flows").first<{ state_hash: string }>()
    expect(stored!.state_hash).not.toBe(url.searchParams.get("state"))
  })
  it("creates a passwordless user via the real callback, uses ordinary JWT auth, rejects code replay and wrong browser proofs", async () => {
    const code = await handoff()
    expect((await post("exchange", { code, verifier: "b".repeat(64) })).status).toBe(400)
    const response = await post("exchange", { code, verifier })
    const pending = await response.json() as { continuation: string; step: string }
    expect(pending.step).toBe("signup")
    expect((await post("exchange", { code, verifier })).status).toBe(400)
    const body = { code: pending.continuation, verifier, username: "alice" }
    const finished = await post("finish", body)
    expect(finished.status).toBe(200)
    const result = await finished.json() as { access_token: string; created: boolean }
    expect(result.created).toBe(true)
    expect((await app.request("/api/v2/auth/me", { headers: { Authorization: `Bearer ${result.access_token}` } }, testEnv)).status).toBe(200)
    expect((await post("finish", body)).status).toBe(400)
    const user = await env.AQUILLA_PG.prepare("SELECT password_hash, email_verified_at FROM users WHERE username='alice'").first<{ password_hash: string | null; email_verified_at: string | null }>()
    expect(user).toMatchObject({ password_hash: null })
    expect(user!.email_verified_at).toBeTruthy()
    expect((await app.request("/api/v2/auth/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "alice", password: "wrong" }) }, testEnv)).status).toBe(401)
    expect(JSON.stringify(await env.AQUILLA_PG.prepare("SELECT * FROM social_login_flows").all())).not.toContain("never-store-this")
    const headers = { Authorization: `Bearer ${result.access_token}` }
    expect((await app.request("/api/v2/auth/refresh", { method: "POST", headers }, testEnv)).status).toBe(200)
    expect((await app.request("/api/v2/auth/logout", { method: "POST", headers }, testEnv)).status).toBe(200)
    expect((await app.request("/api/v2/auth/me", { headers }, testEnv)).status).toBe(401)
    const again = await post("exchange", { code: await handoff(), verifier })
    expect(await again.json()).toMatchObject({ username: "alice", created: false })
  })
  it("does not mark third-party email verified or allow concurrent creation and stale continuations", async () => {
    const callbackResponse = await callback(await start(), { hd: undefined })
    const code = new URLSearchParams(new URL(callbackResponse.headers.get("location")!).hash.slice(1)).get("code")!
    const pending = await (await post("exchange", { code, verifier })).json() as { continuation: string }
    const body = { code: pending.continuation, verifier, username: "alice" }
    const attempts = await Promise.all([post("finish", body), post("finish", body)])
    expect(attempts.filter(r => r.status === 200)).toHaveLength(1)
    expect(await env.AQUILLA_PG.prepare("SELECT email_verified_at FROM users WHERE username='alice'").first()).toEqual({ email_verified_at: null })
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM provider_identities").first()).toEqual({ n: 1 })
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM email_verification_tokens").first()).toEqual({ n: 1 })
  })
  it("fails closed on legacy reservations and throttles social starts independently", async () => {
    const code = await handoff()
    const pending = await (await post("exchange", { code, verifier })).json() as { continuation: string }
    Object.assign(testEnv, { LEGACY_USER_MIGRATION_ENABLED: "true", FRONTIER_D1_ACCOUNT_ID: "local-test", FRONTIER_D1_DATABASE_ID: "local-test", FRONTIER_D1_API_TOKEN: "local-test" })
    const collision = vi.spyOn(legacy, "hasLegacyIdentityCollision").mockResolvedValueOnce(true).mockRejectedValueOnce(new Error("dependency unavailable"))
    const body = { code: pending.continuation, verifier, username: "alice" }
    expect((await post("finish", body)).status).toBe(409)
    expect((await post("finish", body)).status).toBe(503)
    expect(collision).toHaveBeenCalledTimes(2)
    expect(await env.AQUILLA_PG.prepare("SELECT * FROM users").first()).toBeNull()
    await env.AQUILLA_PG.prepare("INSERT INTO auth_rate_limit_events (kind, identifier, success) SELECT 'social_login', ?, 1 FROM generate_series(1,30)").bind(ipIdentifier("unknown")).run()
    expect((await post("start", { challenge: await pkceChallenge(verifier) })).status).toBe(429)
  })
  it("requires existing account password even for verified email and links only once", async () => {
    await seedUser(1, "alice")
    const password = "test-password-123"
    await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=?, email_verified_at=now() WHERE id=1").bind(await hashPasswordWerkzeugScrypt(password)).run()
    const pending = await (await post("exchange", { code: await handoff(), verifier })).json() as { continuation: string; step: string }
    expect(pending.step).toBe("link")
    const body = { code: pending.continuation, verifier, password: "wrong" }
    expect((await post("finish", body)).status).toBe(401)
    expect(await env.AQUILLA_PG.prepare("SELECT * FROM provider_identities").first()).toBeNull()
    const result = await post("finish", { ...body, password })
    expect(result.status).toBe(200)
    expect(await result.json()).toMatchObject({ username: "alice", created: false })
  })
  it("rejects invalid nonce, unverified email, expired state and cancelled or replayed callbacks without a session", async () => {
    for (const claims of [{ nonce: "wrong" }, { email_verified: false }, { iss: "https://attacker.example" }, { aud: "another-client" }, { exp: 1 }, { sub: "" }, { azp: "another-client" }]) {
      const url = await start(), response = await callback(url, claims)
      expect(response.headers.get("location")).toContain("error=provider_failed")
      expect((await callback(url)).status).toBe(400)
    }
    const url = await start()
    network.mockClear()
    const cancel = await app.request(`/api/v2/auth/oauth/google/callback?state=${url.searchParams.get("state")}&error=access_denied`, {}, testEnv)
    expect(cancel.headers.get("location")).toContain("error=cancelled")
    expect(network).not.toHaveBeenCalled()
    const badSignature = await start()
    const otherKey = await generateKeyPair("RS256")
    token = await new SignJWT({ nonce: badSignature.searchParams.get("nonce"), email: "alice@example.com", email_verified: true }).setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer("https://accounts.google.com").setAudience("test-client").setSubject("google-alice").setIssuedAt().setExpirationTime("5m").sign(otherKey.privateKey)
    const rejected = await app.request(`/api/v2/auth/oauth/google/callback?state=${badSignature.searchParams.get("state")}&code=provider-code`, {}, testEnv)
    expect(rejected.headers.get("location")).toContain("error=provider_failed")
    const handoffCode = await handoff()
    await env.AQUILLA_PG.prepare("UPDATE social_login_flows SET expires_at=now()-interval '1 second' WHERE status='ready'").run()
    expect((await post("exchange", { code: handoffCode, verifier })).status).toBe(400)
    const pending = await (await post("exchange", { code: await handoff(), verifier })).json() as { continuation: string }
    await env.AQUILLA_PG.prepare("UPDATE social_login_flows SET expires_at=now()-interval '1 second' WHERE status='pending'").run()
    expect((await post("finish", { code: pending.continuation, verifier, username: "alice" })).status).toBe(400)
    const expired = await start()
    await env.AQUILLA_PG.prepare("UPDATE social_login_flows SET expires_at=now()-interval '1 second'").run()
    expect((await callback(expired)).status).toBe(400)
    expect(await env.AQUILLA_PG.prepare("SELECT * FROM users").first()).toBeNull()
  })
})

it("upgrades existing password users without changing their hashes and permits passwordless identities", async () => {
  const pg = new PGlite()
  try {
    await pg.exec("CREATE TABLE users (id BIGINT PRIMARY KEY, password_hash TEXT NOT NULL); INSERT INTO users VALUES (1, 'existing-hash')")
    const migration = readFileSync(new NodeURL("../../../db/postgres/migrations/0199_google_login.sql", import.meta.url), "utf8")
    await pg.exec(migration)
    await pg.exec(migration)
    await pg.exec("INSERT INTO users VALUES (2, NULL); INSERT INTO provider_identities(provider,subject,user_id) VALUES ('google','subject',2)")
    expect((await pg.query("SELECT password_hash FROM users ORDER BY id")).rows).toEqual([{ password_hash: "existing-hash" }, { password_hash: null }])
    await expect(pg.exec("INSERT INTO provider_identities(provider,subject,user_id) VALUES ('google','subject',1)")).rejects.toThrow()
    await pg.exec("DELETE FROM users WHERE id=2")
    expect((await pg.query("SELECT * FROM provider_identities")).rows).toHaveLength(0)
  } finally { await pg.close() }
})
