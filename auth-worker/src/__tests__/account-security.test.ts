import { env } from "cloudflare:test"
import { beforeEach, afterEach, describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { totp } from "../lib/admin-totp"
import { sha256Hex } from "../../../db/shared/api-credentials"
import { pkceChallenge } from "../routes/oauth-google"
let jwt: string
const call = (path: string, body?: object, token = jwt) =>
  app.request(
    `/api/v2/auth/${path}`,
    {
      method: body ? "POST" : "GET",
      headers: authHeader(token),
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
    env,
  )
beforeEach(async () => {
  env.ADMIN_TOTP_KEY = "test-only-account-security-encryption-key-12345"
  await seedUser(1, "alice")
  await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=? WHERE id=1")
    .bind(await hashPasswordWerkzeugScrypt("correct password"))
    .run()
  jwt = await jwtFor("alice")
})
afterEach(() => {
  delete env.ADMIN_TOTP_KEY
})
async function enroll() {
  expect(
    (await call("security/password-proof", { password: "correct password" }))
      .status,
  ).toBe(200)
  const r = await call("security/setup", {})
  expect(r.status).toBe(200)
  const s = (await r.json()) as { secret: string; generation: string }
  const confirm = await call("security/confirm", {
    generation: s.generation,
    code: await totp(s.secret, Math.floor(Date.now() / 30000)),
  })
  expect(confirm.status).toBe(200)
  const codes = (await confirm.json()) as { recoveryCodes: string[] }
  expect(
    (
      await call("security/complete", {
        generation: s.generation,
        savedRecoveryCodes: true,
      })
    ).status,
  ).toBe(200)
  return { ...s, ...codes }
}
describe("account security", () => {
  it("requires primary proof for setup and protects settings without blocking normal login", async () => {
    expect((await call("security/setup", {})).status).toBe(403)
    const s = await enroll()
    const other = await jwtFor("alice", Math.floor(Date.now() / 1000) - 60)
    expect((await call("oauth/google/methods", undefined, other)).status).toBe(
      200,
    )
    expect(
      (
        await call(
          "email-change/request",
          { email: "new@example.com", password: "correct password" },
          other,
        )
      ).status,
    ).toBe(403)
    expect(
      (
        await call(
          "security/verify",
          { code: s.recoveryCodes[0], recovery: true },
          other,
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await call(
          "security/verify",
          { code: s.recoveryCodes[0], recovery: true },
          other,
        )
      ).status,
    ).toBe(403)
    expect(
      await (await call("security", undefined, other)).json(),
    ).toMatchObject({ enabled: true, verified: true })
    const row = await env.AQUILLA_PG.prepare(
      "SELECT * FROM account_security",
    ).first()
    expect(JSON.stringify(row)).not.toContain(s.secret)
    for (const code of s.recoveryCodes)
      expect(JSON.stringify(row)).not.toContain(code)
  })
  it("does not remove the last method or accept password proof as Google proof", async () => {
    expect((await call("security/remove-password", {})).status).toBe(403)
    await call("security/password-proof", { password: "correct password" })
    expect((await call("security/remove-password", {})).status).toBe(403)
    expect(
      (
        await env.AQUILLA_PG.prepare(
          "SELECT password_hash FROM users WHERE id=1",
        ).first<{ password_hash: string }>()
      )?.password_hash,
    ).toBeTruthy()
  })
  it("removes passwords only after linked Google proof and invalidates reset tokens and old sessions", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','subject',1)",
    ).run()
    const code = "a".repeat(64),
      verifier = "b".repeat(64)
    await env.AQUILLA_PG.prepare(
      `INSERT INTO social_login_flows(state_hash,browser_challenge,nonce,app_origin,status,code_hash,subject,email,expires_at) VALUES(?,?,'nonce','https://aquilla.app','ready',?,'subject','alice@example.com',now()+interval '5 minutes')`,
    )
      .bind(
        "c".repeat(64),
        await pkceChallenge(verifier),
        await sha256Hex(code),
      )
      .run()
    env.GOOGLE_LOGIN_CLIENT_ID = "id"
    env.GOOGLE_LOGIN_CLIENT_SECRET = "secret"
    env.GOOGLE_LOGIN_REDIRECT_URI = "https://api.example/callback"
    env.GOOGLE_LOGIN_APP_ORIGINS = "https://aquilla.app"
    try {
      expect(
        (await call("oauth/google/reauthenticate", { code, verifier })).status,
      ).toBe(200)
      const removed = await call("security/remove-password", {})
      expect(removed.status).toBe(200)
      expect(
        await env.AQUILLA_PG.prepare(
          "SELECT password_hash,password_login_disabled FROM users WHERE id=1",
        ).first(),
      ).toEqual({ password_hash: null, password_login_disabled: true })
      expect((await call("oauth/google/methods")).status).toBe(401)
      const result = (await removed.json()) as { access_token: string }
      expect(
        (await call("oauth/google/methods", undefined, result.access_token))
          .status,
      ).toBe(200)
    } finally {
      delete env.GOOGLE_LOGIN_CLIENT_ID
      delete env.GOOGLE_LOGIN_CLIENT_SECRET
      delete env.GOOGLE_LOGIN_REDIRECT_URI
      delete env.GOOGLE_LOGIN_APP_ORIGINS
    }
  })
})

it("requires a factor for email reset, consumes recovery once, and keeps ordinary password login available", async () => {
  const s = await enroll()
  const token = "reset-proof-for-security-test"
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,email_at_issue) VALUES(1,?,now()+interval '1 hour','alice@example.com')",
  )
    .bind(await sha256Hex(token))
    .run()
  const body = {
    token,
    username: "alice",
    new_password: "another strong password",
  }
  expect((await call("password-reset/reset", body)).status).toBe(403)
  expect(
    (
      await call("password-reset/reset", {
        ...body,
        factor_code: "000000",
        recovery: true,
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await call("password-reset/reset", {
        ...body,
        factor_code: s.recoveryCodes[0],
        recovery: true,
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await call("password-reset/reset", {
        ...body,
        factor_code: s.recoveryCodes[0],
        recovery: true,
      })
    ).status,
  ).toBe(400)
  expect(
    await env.AQUILLA_PG.prepare(
      "SELECT enabled FROM account_security WHERE user_id=1",
    ).first(),
  ).toEqual({ enabled: true })
})
it("enforces protection across sibling previews and expires grants", async () => {
  await enroll()
  await env.AQUILLA_PG.prepare(
    "UPDATE account_security_grants SET expires_at=now()-interval '1 second'",
  ).run()
  const previewEnv = {
    ...env,
    ENVIRONMENT: "preview",
    DEPLOYMENT_WORKER_NAME: "another-auth-preview",
    BASE_URL: "https://another-preview.example",
  }
  const r = await app.request(
    "/api/v2/auth/email-change/request",
    {
      method: "POST",
      headers: authHeader(jwt),
      body: JSON.stringify({
        email: "new@example.com",
        password: "correct password",
      }),
    },
    previewEnv,
  )
  expect(r.status).toBe(403)
  expect(await r.json()).toEqual({ error: "settings_verification_required" })
})
it("rolls factor consumption back when a password reset transaction fails", async () => {
  const s = await enroll(),
    token = "rollback-reset-proof"
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,email_at_issue) VALUES(1,?,now()+interval '1 hour','alice@example.com')",
  )
    .bind(await sha256Hex(token))
    .run()
  const { pg } = await import("./helpers/pg-test-env")
  await pg.exec(
    "CREATE FUNCTION fail_security_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'forced failure'; END $$; CREATE TRIGGER fail_security_test BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fail_security_test();",
  )
  try {
    expect(
      (
        await call("password-reset/reset", {
          token,
          username: "alice",
          new_password: "another strong password",
          factor_code: s.recoveryCodes[0],
          recovery: true,
        })
      ).status,
    ).toBe(500)
    expect(
      await env.AQUILLA_PG.prepare(
        "SELECT 1 FROM password_reset_tokens WHERE user_id=1",
      ).first(),
    ).toBeTruthy()
  } finally {
    await pg.exec(
      "DROP TRIGGER fail_security_test ON users; DROP FUNCTION fail_security_test();",
    )
  }
  expect(
    (
      await call("security/verify", {
        code: s.recoveryCodes[0],
        recovery: true,
      })
    ).status,
  ).toBe(200)
})
it("limits overlapping factor guesses even when the session is valid", async () => {
  const s = await enroll()
  const results = await Promise.all(
    Array.from({ length: 12 }, () =>
      call("security/verify", { code: "invalid", recovery: true }),
    ),
  )
  expect(results.some((r) => r.status === 429)).toBe(true)
  expect(
    (
      await call("security/verify", {
        code: s.recoveryCodes[0],
        recovery: true,
      })
    ).status,
  ).toBe(429)
})

it("invalidates old recovery codes and grants when recovery codes are replaced", async () => {
  const s = await enroll()
  const other = await jwtFor("alice", Math.floor(Date.now() / 1000) - 60)
  expect(
    (
      await call(
        "security/verify",
        { code: s.recoveryCodes[0], recovery: true },
        other,
      )
    ).status,
  ).toBe(200)
  const replacement = await call("security/verify", {
    code: s.recoveryCodes[1],
    recovery: true,
    regenerate: true,
  })
  expect(replacement.status).toBe(200)
  expect(await (await call("security", undefined, other)).json()).toMatchObject(
    { verified: false },
  )
  expect(
    (
      await call(
        "security/verify",
        { code: s.recoveryCodes[2], recovery: true },
        other,
      )
    ).status,
  ).toBe(403)
  const codes = (await replacement.json()) as { recoveryCodes: string[] }
  expect(
    (
      await call(
        "security/verify",
        { code: codes.recoveryCodes[0], recovery: true },
        other,
      )
    ).status,
  ).toBe(200)
})
it("does not let public reset re-enable an explicitly removed password", async () => {
  const token = "disabled-password-reset"
  await env.AQUILLA_PG.prepare(
    "UPDATE users SET password_hash=NULL,password_login_disabled=true WHERE id=1",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens(user_id,token_hash,expires_at,email_at_issue) VALUES(1,?,now()+interval '1 hour','alice@example.com')",
  )
    .bind(await sha256Hex(token))
    .run()
  expect(
    (
      await call("password-reset/reset", {
        token,
        username: "alice",
        new_password: "a strong password",
      })
    ).status,
  ).toBe(400)
  expect(
    await env.AQUILLA_PG.prepare(
      "SELECT password_hash,password_login_disabled FROM users WHERE id=1",
    ).first(),
  ).toEqual({ password_hash: null, password_login_disabled: true })
})
it("does not let a second session complete an authenticator setup", async () => {
  await call("security/password-proof", { password: "correct password" })
  const setup = (await (await call("security/setup", {})).json()) as {
    secret: string
    generation: string
  }
  const other = await jwtFor("alice", Math.floor(Date.now() / 1000) - 60)
  expect(
    (
      await call(
        "security/confirm",
        {
          generation: setup.generation,
          code: await totp(setup.secret, Math.floor(Date.now() / 30000)),
        },
        other,
      )
    ).status,
  ).toBe(403)
  await env.AQUILLA_PG.prepare(
    "UPDATE account_security SET expires_at=now()-interval '1 second'",
  ).run()
  expect(
    (
      await call("security/confirm", {
        generation: setup.generation,
        code: await totp(setup.secret, Math.floor(Date.now() / 30000)),
      })
    ).status,
  ).toBe(403)
})
it("rejects factor bypasses on password changes, Google linking and Google removal", async () => {
  await enroll()
  const other = await jwtFor("alice", Math.floor(Date.now() / 1000) - 60)
  expect(
    (
      await call(
        "security/password-proof",
        { password: "correct password" },
        other,
      )
    ).status,
  ).toBe(200)
  expect(
    (
      await call(
        "security/password",
        { password: "a replacement password" },
        other,
      )
    ).status,
  ).toBe(403)
  expect(
    (
      await call(
        "oauth/google/disconnect",
        { password: "correct password" },
        other,
      )
    ).status,
  ).toBe(403)
  expect((await call("security/remove-password", {}, other)).status).toBe(403)
})

it.each([false,true])("preserves first-password sessions but revokes credentials when replacing=%s",async(replacing)=>{
 const {resolveSession}=await import("../middleware/auth")
 if(!replacing) await env.AQUILLA_PG.prepare("UPDATE users SET password_hash=NULL WHERE id=1").run()
 await env.AQUILLA_PG.prepare("INSERT INTO provider_identities(provider,subject,user_id) VALUES('google','subject',1)").run()
 const session=await resolveSession(env,`Bearer ${jwt}`,{fresh:true});if(!session.ok)throw Error("fixture session failed")
 await env.AQUILLA_PG.prepare("INSERT INTO account_security_grants(user_id,deployment,session_key,kind,generation,expires_at) VALUES(1,'development',?,'google','subject',now()+interval '5 minutes')").bind(session.sessionKey).run()
 await env.AQUILLA_PG.prepare("INSERT INTO api_credentials(id,user_id,name,token_prefix,token_hash,mode) VALUES(?,'1','test','prefix','test-hash','ask')").bind(crypto.randomUUID()).run()
 const changed=await call("security/password",{password:"new test password"})
 expect(changed.status).toBe(200)
 expect((await call("security")).status).toBe(replacing?401:200)
 expect(await env.AQUILLA_PG.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM api_credentials WHERE user_id='1'").first()).toEqual({revoked:replacing})
 const token=(await changed.json() as {access_token:string}).access_token
 expect((await call("security",undefined,token)).status).toBe(200)
})
