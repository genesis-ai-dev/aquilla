import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { pkceChallenge } from "../routes/oauth-google"
const send = vi.fn(async (_mail: { text: string }) => {})
let jwt: string
const testEnv = Object.assign(Object.create(env), { EMAIL: { send } })
const post = (path: string, body: object) =>
  app.request(
    `/api/v2/auth/email-change/${path}`,
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify(body) },
    testEnv,
  )
const code = () => send.mock.calls.at(-1)![0].text.match(/[a-f0-9]{48}/)![0]
beforeEach(async () => {
  send.mockReset()
  send.mockResolvedValue(undefined)
  delete testEnv.DEPLOYMENT_WORKER_NAME
  delete testEnv.DEV_ACCESS_LIST
  delete testEnv.ADMIN_REQUIRE_ELEVATION
  delete testEnv.WRANGLER_LOCAL
  delete testEnv.ADMIN_EMAILS
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1")
    .bind(await hashPasswordWerkzeugScrypt("a strong password"))
    .run()
  jwt = await jwtFor("alice")
})
const request = () =>
  post("request", { email: "new@example.com", password: "a strong password" })
describe("verified email changes", () => {
  it("changes only after mailbox proof, preserves Google and revokes the old session", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','stable-sub',1)",
    ).run()
    expect((await request()).status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT email FROM users WHERE id=1",
      ).first(),
    ).toEqual({ email: "alice@example.com" })
    expect((await post("confirm", { token: code() })).status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT email,session_version FROM users WHERE id=1",
      ).first(),
    ).toEqual({ email: "new@example.com", session_version: 1 })
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT subject,user_id FROM provider_identities",
      ).first(),
    ).toEqual({ subject: "stable-sub", user_id: 1 })
    expect(
      (
        await app.request(
          "/api/v2/auth/me",
          { headers: authHeader(jwt) },
          testEnv,
        )
      ).status,
    ).toBe(401)
  })
  it("rejects incorrect password and sends nothing", async () => {
    expect(
      (await post("request", { email: "new@example.com", password: "wrong" }))
        .status,
    ).toBe(401)
    expect(send).not.toHaveBeenCalled()
  })
  it("rejects reserved admin addresses", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO platform_admins(email) VALUES('new@example.com')",
    ).run()
    expect((await request()).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })
  it("keeps email unchanged if delivery fails", async () => {
    send.mockRejectedValueOnce(new Error("unavailable"))
    expect((await request()).status).toBe(503)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT count(*)::int n FROM email_change_requests",
      ).first(),
    ).toEqual({ n: 0 })
  })
  it("expires mailbox proofs", async () => {
    await request()
    const token = code()
    await env.AQUILLA_PG.prepare(
      "UPDATE email_change_requests SET expires_at=now()-interval '1 second'",
    ).run()
    expect((await post("confirm", { token })).status).toBe(400)
  })
  it("invalidates a previous request when a replacement is sent", async () => {
    await request()
    const token = code()
    await request()
    expect((await post("confirm", { token })).status).toBe(400)
  })
  it("does not grant dev access for a new destination", async () => {
    testEnv.DEPLOYMENT_WORKER_NAME = "aquilla-auth-preview"
    testEnv.DEV_ACCESS_LIST = {
      get: async (email: string) =>
        email === "alice@example.com" ? "allowed" : null,
    }
    expect((await request()).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })
  it("accepts only a fresh Google proof linked to this account", async () => {
    await env.AQUILLA_PG.prepare(
      "UPDATE users SET password_hash=NULL WHERE id=1",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','stable-sub',1)",
    ).run()
    const googleCode = "c".repeat(64),
      verifier = "d".repeat(64)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO social_login_flows(state_hash,browser_challenge,google_verifier,nonce,app_origin,status,subject,email,code_hash,expires_at)
   VALUES('state',?,'v','n','https://example.com','ready','stable-sub','old-google@example.com',?,now()+interval '5 minutes')`,
    )
      .bind(await pkceChallenge(verifier), await sha256Hex(googleCode))
      .run()
    expect(
      (
        await post("request", {
          email: "new@example.com",
          google: { code: googleCode, verifier },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await post("request", {
          email: "new@example.com",
          google: { code: googleCode, verifier },
        })
      ).status,
    ).toBe(401)
  })
  it("preserves database admin grant atomically", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO platform_admins(email) VALUES('alice@example.com')",
    ).run()
    expect((await request()).status).toBe(200)
    expect((await post("confirm", { token: code() })).status).toBe(200)
    expect(
      await env.AQUILLA_PG.prepare("SELECT email FROM platform_admins").first(),
    ).toEqual({ email: "new@example.com" })
  })
  it("refuses a destination taken after the email was sent", async () => {
    await request()
    const token = code()
    await seedUser(2, "new")
    expect((await post("confirm", { token })).status).toBe(403)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT email FROM users WHERE id=1",
      ).first(),
    ).toEqual({ email: "alice@example.com" })
  })
  it("allows exactly one concurrent confirmation", async () => {
    await request()
    const token = code()
    const results = await Promise.all([
      post("confirm", { token }),
      post("confirm", { token }),
    ])
    expect(results.filter((r) => r.status === 200)).toHaveLength(1)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT session_version FROM users WHERE id=1",
      ).first(),
    ).toEqual({ session_version: 1 })
  })
  it("rejects a proof after a password reset generation change", async () => {
    await request()
    const token = code()
    await env.AQUILLA_PG.prepare(
      "UPDATE users SET session_version=session_version+1 WHERE id=1",
    ).run()
    expect((await post("confirm", { token })).status).not.toBe(200)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT email FROM users WHERE id=1",
      ).first(),
    ).toEqual({ email: "alice@example.com" })
  })
  it("deletes old reset and email-verification capabilities", async () => {
    await env.AQUILLA_PG.prepare("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at) VALUES(1,'old-reset',now()+interval '1 day')").run()
    await env.AQUILLA_PG.prepare("INSERT INTO email_verification_tokens(user_id,token_hash,expires_at) VALUES(1,'old-verification',now()+interval '1 day')").run()
    await request()
    expect((await post("confirm",{token:code()})).status).toBe(200)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int n FROM password_reset_tokens").first()).toEqual({n:0})
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int n FROM email_verification_tokens").first()).toEqual({n:0})
  })
  it("requires admin step-up on production", async () => {
    testEnv.DEPLOYMENT_WORKER_NAME="aquilla-identity"
    testEnv.ADMIN_REQUIRE_ELEVATION="true"
    testEnv.WRANGLER_LOCAL="0"
    await env.AQUILLA_PG.prepare("INSERT INTO platform_admins(email) VALUES('alice@example.com')").run()
    expect((await request()).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it("rejects an email that is another account's username", async () => {
    await seedUser(2,"new@example.com")
    expect((await request()).status).toBe(403)
    expect(send).not.toHaveBeenCalled()
  })

  it.each(["alice@example.com",null])("rejects delayed old-mailbox reset proof: %s", async (emailAtIssue) => {
    await request()
    expect((await post("confirm",{token:code()})).status).toBe(200)
    const token="delayed-reset-token"
    await env.AQUILLA_PG.prepare("INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,email_at_issue) VALUES(1,?,now()+interval '1 day',?)").bind(await sha256Hex(token),emailAtIssue).run()
    const response=await app.request("/api/v2/auth/password-reset/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"alice",token,new_password:"a replacement password"})},testEnv)
    expect(response.status).toBe(400)
    expect(await env.AQUILLA_PG.prepare("SELECT session_version FROM users WHERE id=1").first()).toEqual({session_version:1})
  })

  it("accepts password recovery issued to the newly verified email", async () => {
    await request()
    expect((await post("confirm",{token:code()})).status).toBe(200)
    send.mockClear()
    expect((await app.request("/api/v2/auth/password-reset/request",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:"new@example.com"})},testEnv)).status).toBe(200)
    const mail=send.mock.calls.at(-1)![0].text
    const token=new URL(mail.replace("Reset your password: ","")).searchParams.get("token")
    expect(token).toBeTruthy()
    const response=await app.request("/api/v2/auth/password-reset/reset",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:"alice",token,new_password:"a replacement password"})},testEnv)
    expect(response.status).toBe(200)
  })

})
