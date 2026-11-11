import * as passwordUtil from "../utils/password"
import { env } from "cloudflare:test"
import { describe, it, expect, vi } from "vitest"
import app from "../index"
import { sha256Hex } from "../../../db/shared/api-credentials"

// End-to-end coverage for the account-recovery path. The /reset-password PAGE
// (AQU-270) and the SPA edge fallback already make the email link reachable;
// these guard the verify + reset ENDPOINTS the page depends on — the audit's
// #1 risk ("account recovery") was previously untested at the API level.

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

/** Plant a reset token in the shape the route actually writes: digest only
 *  (OPS-20/OPS-31). The plaintext is never stored, so a test that needs a
 *  usable token has to hash it in the same way the handler will.
 *
 *  Until 2026-09-07 this helper seeded PLAINTEXT rows, which meant every test
 *  below reached the verify/reset handlers through 0080's `token_hash IS NULL`
 *  compatibility arm rather than the digest lookup that production uses. */
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

const soon = () => new Date(Date.now() + 3600_000).toISOString()

describe("password reset — invitation context (AQU-2298)", () => {
  it.each([
    ["invited", "/join-org/invite-token", "/join-org/invite-token"],
    ["ordinary", undefined, null],
    ["settings", "/preferences/login-methods", "/preferences/login-methods"],
    ["settingsquery", "/preferences/login-methods?next=https://evil.test", null],
    ["external", "https://example.com/join-org/invite-token", null],
    ["relativehost", "//example.com/join-org/invite-token", null],
    ["dotpath", "/join-org/../settings", null],
    ["encoded", "/join-org/invite%2Ftoken", null],
    ["query", "/join-org/invite-token?next=/settings", null],
    ["newline", "/join-org/invite-token\n", null],
  ])("emits a usable email reset link with safe context: %s", async (suffix, returnTo, expected) => {
    const username = `recover${suffix}`
    const email = `${username}@example.com`
    expect((await register(username, email, "old-password-1")).status).toBe(200)
    const send = vi.fn(async (_message: { text?: string; html?: string }) => ({ messageId: "test-reset" }))
    const response = await app.request("/api/v2/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, return_to: returnTo }),
    }, { ...env, EMAIL: { send } })
    expect(response.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
    const resetLink = send.mock.calls[0][0].text!.match(/https?:\/\/\S+\/reset-password\?\S+/)![0]
    const url = new URL(resetLink)
    expect(url.searchParams.get("returnTo")).toBe(expected)
    expect(url.searchParams.get("username")).toBe(username)
    const credentials = { username, token: url.searchParams.get("token") }
    expect((await reqJson("/api/v2/auth/password-reset/verify", credentials)).status).toBe(200)
    expect((await reqJson("/api/v2/auth/password-reset/reset", {
      ...credentials, new_password: "NewPassword123!",
    })).status).toBe(200)
    expect((await reqJson("/api/v2/auth/token", { username, password: "NewPassword123!" })).status).toBe(200)
  })
})

// AQU-675 regression guard. Reported live (Biblica ETT sync 2026-07-16):
// requesting a reset with an email that has NO account silently created a fresh
// account for that address (and emailed a reset link to it). The account-
// recovery request endpoint must never mint an account as a side effect — it
// looks the user up by email and, on a miss, returns the same generic response
// without creating a user or a token (so the address still can't sign in, and
// there's no enumeration oracle). These assertions pin that behavior.
describe("password reset — request (AQU-675: never creates an account)", () => {
  it("does not create an account (or mint a reset token) for an unknown email", async () => {
    const unknown = "aqu675-unknown@example.com"

    // Precondition: no account exists for this address.
    const before = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = LOWER(?)",
    )
      .bind(unknown)
      .first<{ n: number }>()
    expect(Number(before!.n)).toBe(0)

    // Anti-enumeration: a generic 200 whether or not the email is registered.
    const res = await reqJson("/api/v2/auth/password-reset/request", { email: unknown })
    expect(res.status).toBe(200)

    // The bug: this used to leave a brand-new account behind. It must not.
    const after = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE LOWER(email) = LOWER(?)",
    )
      .bind(unknown)
      .first<{ n: number }>()
    expect(Number(after!.n)).toBe(0)

    // No reset token was minted for the phantom account either — nothing to
    // email out, so the address never receives a usable reset link.
    const tokens = await env.AQUILLA_PG.prepare(
      `SELECT COUNT(*) AS n FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id
       WHERE LOWER(u.email) = LOWER(?)`,
    )
      .bind(unknown)
      .first<{ n: number }>()
    expect(Number(tokens!.n)).toBe(0)

    // Observable consequence: the address cannot subsequently sign in without
    // going through real sign-up (acceptance criterion #1).
    const login = await reqJson("/api/v2/auth/token", {
      username: unknown,
      password: "whatever-pw-9",
    })
    expect(login.status).toBe(401)
  })

  // AQU-751 regression guard. Reported live (Codex→Aquilla migration testing,
  // 2026-07-29): reset emails never arrived on production for migrated accounts.
  // Root cause: this endpoint looked the user up with a case-SENSITIVE
  // `email = ?`, while login (jwt.getUserByEmail) and registration both
  // canonicalize with LOWER(email). Any account whose stored email casing
  // differed from what the requester typed (common for migrated accounts) hit
  // the generic 200 branch without ever minting a token — so nothing was sent.
  // This pins the case-insensitive lookup so the reset link is reachable.
  it("mints a reset token when the requested email differs only in casing", async () => {
    // Stored casing (as a migration might have set it) differs from what the
    // user types in the reset form.
    await register("aqu751migrated", "Aqu751.Migrated@Example.com", "old-password-1")

    const res = await reqJson("/api/v2/auth/password-reset/request", {
      email: "aqu751.migrated@example.com",
    })
    expect(res.status).toBe(200)

    // The account got a usable reset token despite the casing mismatch — before
    // the fix the case-sensitive lookup found no user and minted nothing.
    const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
      .bind("aqu751migrated")
      .first<{ id: number }>()
    const tok = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?",
    )
      .bind(u!.id)
      .first<{ n: number }>()
    expect(Number(tok!.n)).toBeGreaterThanOrEqual(1)
  })

  it("mints a reset token for a real account's email without creating any account", async () => {
    await register("aqu675real", "aqu675real@example.com", "old-password-1")

    const totalBefore = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).first<{ n: number }>()

    const res = await reqJson("/api/v2/auth/password-reset/request", {
      email: "aqu675real@example.com",
    })
    expect(res.status).toBe(200)

    // The real account now has a usable reset token (the link is reachable)...
    const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
      .bind("aqu675real")
      .first<{ id: number }>()
    const tok = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?",
    )
      .bind(u!.id)
      .first<{ n: number }>()
    expect(Number(tok!.n)).toBeGreaterThanOrEqual(1)

    // ...and no extra account was created as a side effect (criterion #3).
    const totalAfter = await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).first<{ n: number }>()
    expect(Number(totalAfter!.n)).toBe(Number(totalBefore!.n))
  })

  // [Pen test] Auth & session mgmt (2026-08-24), OPS-20. The minted token is a
  // 24-hour account-takeover credential; it must not be readable from the
  // table, so a snapshot/replica/support query of password_reset_tokens is not
  // a set of live takeover links.
  // Since OPS-31 (migration 0087) the guarantee is structural: there is no
  // column a plaintext reset token could be written to. Assert the schema as
  // well as the value, so re-adding the column fails here rather than
  // silently restoring a readable-credential table.
  it("stores the reset token as a digest, with no plaintext column to leak (OPS-20/OPS-31)", async () => {
    await register("ops20user", "ops20user@example.com", "old-password-1")
    await reqJson("/api/v2/auth/password-reset/request", { email: "ops20user@example.com" })

    const row = await env.AQUILLA_PG.prepare(
      `SELECT t.token_hash FROM password_reset_tokens t
       JOIN users u ON u.id = t.user_id WHERE u.username = 'ops20user'`,
    ).first<{ token_hash: string | null }>()

    expect(row).toBeTruthy()
    expect(row!.token_hash).toMatch(/^[0-9a-f]{64}$/)

    const plaintextColumn = await env.AQUILLA_PG.prepare(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'password_reset_tokens' AND column_name = 'token'`,
    ).first<{ column_name: string }>()
    expect(plaintextColumn).toBeNull()
  })

  // [Pen test] Auth & session mgmt (2026-09-07), OPS-31. The rollover test
  // that used to sit here ("still accepts a pre-0080 plaintext token row")
  // was deleted with the compatibility arm it covered: the 24-hour window
  // closed on 2026-08-25, and migration 0087 dropped the column it read.
  // Its replacement is the assertion below — a row with no digest match is
  // rejected, which is now the only shape a plaintext row could take.
  it("rejects a reset token that has no matching digest (post-OPS-31)", async () => {
    await register("ops27user", "ops27user@example.com", "old-password-1")
    await seedToken("ops27user", "the-real-token-1", soon())

    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "not-the-real-token-1",
      username: "ops27user",
    })
    expect(res.status).toBe(400)
  })

  // [Pen test] Auth & session mgmt (2026-08-24), OPS-19. The whole handler
  // used to sit inside one catch that returned
  // `Failed to send reset email: ${err.message}` with a 500 — which (a)
  // reflected raw internal error text to an unauthenticated caller, the same
  // bug SEC-11 fixed in /register, and (b) meant any failure in the
  // REGISTERED-ONLY work below the lookup produced a visibly different
  // response from the generic 200 an unregistered address gets. That
  // difference is a user-enumeration oracle — the exact one the 2026-07-20
  // pass closed for email-send failures and left open for everything else on
  // that branch.
  //
  // Simulated by making the token INSERT fail for the duration of the request
  // (a CHECK the row can't satisfy), which is the first registered-only
  // statement in the handler.
  it("returns the generic response when the registered-only work fails (OPS-19)", async () => {
    await register("ops19user", "ops19user@example.com", "old-password-1")

    const unregistered = await reqJson("/api/v2/auth/password-reset/request", {
      email: "ops19-nobody@example.com",
    })
    const generic = await unregistered.json()

    await env.AQUILLA_PG.prepare(
      "ALTER TABLE password_reset_tokens ADD CONSTRAINT ops19_break CHECK (false) NOT VALID",
    ).run()
    try {
      const res = await reqJson("/api/v2/auth/password-reset/request", {
        email: "ops19user@example.com",
      })
      // Indistinguishable from the unregistered-address response, in both
      // status and body — no oracle, and no internal error text.
      expect(res.status).toBe(unregistered.status)
      expect(await res.json()).toEqual(generic)
      // Proof the failure path was actually exercised rather than the
      // constraint silently not biting: the mint really did fail.
      const tok = await env.AQUILLA_PG.prepare(
        `SELECT COUNT(*) AS n FROM password_reset_tokens t
         JOIN users u ON u.id = t.user_id WHERE u.username = 'ops19user'`,
      ).first<{ n: number }>()
      expect(Number(tok!.n)).toBe(0)
    } finally {
      await env.AQUILLA_PG.prepare(
        "ALTER TABLE password_reset_tokens DROP CONSTRAINT ops19_break",
      ).run()
    }
  })
})

describe("password reset — verify", () => {
  it("accepts a valid token", async () => {
    await register("ruser", "ruser@example.com", "old-password-1")
    await seedToken("ruser", "validtoken1234567890", soon())
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "validtoken1234567890",
      username: "ruser",
    })
    expect(res.status).toBe(200)
  })

  it("rejects an unknown token (400)", async () => {
    await register("ruser2", "ruser2@example.com", "old-password-1")
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "nopetoken1234567890",
      username: "ruser2",
    })
    expect(res.status).toBe(400)
  })

  it("rejects an expired token (400)", async () => {
    await register("ruser3", "ruser3@example.com", "old-password-1")
    await seedToken("ruser3", "expiredtoken1234567890", "2000-01-01T00:00:00Z")
    const res = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "expiredtoken1234567890",
      username: "ruser3",
    })
    expect(res.status).toBe(400)
  })
})

describe("password reset — reset (full recovery loop)", () => {
  it("changes the password, lets the user log in with the new one, and consumes the token", async () => {
    await register("ruser4", "ruser4@example.com", "old-password-1")
    await seedToken("ruser4", "resettoken1234567890", soon())

    const reset = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "resettoken1234567890",
      username: "ruser4",
      new_password: "brand-new-pw-9",
    })
    expect(reset.status).toBe(200)

    // The old password no longer authenticates...
    const oldLogin = await reqJson("/api/v2/auth/token", {
      username: "ruser4",
      password: "old-password-1",
    })
    expect(oldLogin.status).toBe(401)

    // ...and the new one does.
    const newLogin = await reqJson("/api/v2/auth/token", {
      username: "ruser4",
      password: "brand-new-pw-9",
    })
    expect(newLogin.status).toBe(200)

    // The token is single-use — a replay no longer verifies.
    const replay = await reqJson("/api/v2/auth/password-reset/verify", {
      token: "resettoken1234567890",
      username: "ruser4",
    })
    expect(replay.status).toBe(400)
  })

  it("rejects a reset with an expired token (400)", async () => {
    await register("ruser5", "ruser5@example.com", "old-password-1")
    await seedToken("ruser5", "expiredreset1234567890", "2000-01-01T00:00:00Z")
    const res = await reqJson("/api/v2/auth/password-reset/reset", {
      token: "expiredreset1234567890",
      username: "ruser5",
      new_password: "brand-new-pw-9",
    })
    expect(res.status).toBe(400)
  })
})

// 2026-11-02 regression guard. PR #1761 moved the token mint and the send off
// the response (executionCtx.waitUntil) so a registered address answers as
// fast as an unregistered one. Every test above calls app.request without an
// ExecutionContext and so takes the inline fallback; this one goes through a
// real one and checks the deferred work still finishes: once the waitUntil
// promises settle, the token row exists and the mail went out. (The production
// failure — the request-scoped connection being closed under the deferred
// work — is covered by lib/post-response-db.test.ts and end to end by
// e2e/specs/projects/share-invite.smoke.spec.ts.)
describe("password reset — request deferred past the response (executionCtx)", () => {
  it("mints the token and sends the email after the response, through waitUntil", async () => {
    const username = "deferredreset"
    const email = `${username}@example.com`
    expect((await register(username, email, "old-password-1")).status).toBe(200)
    const send = vi.fn(async (_message: { text?: string; html?: string }) => ({ messageId: "test-reset" }))
    const deferred: Promise<unknown>[] = []
    const ctx = {
      waitUntil: (p: Promise<unknown>) => { deferred.push(p) },
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext

    const response = await app.request("/api/v2/auth/password-reset/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    }, { ...env, EMAIL: { send } }, ctx)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ message: "Password reset link sent to your email" })
    expect(deferred).toHaveLength(1)
    await Promise.all(deferred)

    const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
      .bind(username)
      .first<{ id: number }>()
    const tokens = await env.AQUILLA_PG.prepare("SELECT COUNT(*) AS n FROM password_reset_tokens WHERE user_id = ?")
      .bind(u!.id)
      .first<{ n: number }>()
    expect(Number(tokens!.n)).toBe(1)
    expect(send).toHaveBeenCalledOnce()
    const resetLink = send.mock.calls[0][0].text!.match(/https?:\/\/\S+\/reset-password\?\S+/)![0]
    expect(new URL(resetLink).searchParams.get("username")).toBe(username)
    const activity = await env.AQUILLA_PG.prepare(
      "SELECT activity_type FROM activity_logs WHERE user_id = ? AND activity_type = 'password_reset_requested'",
    )
      .bind(u!.id)
      .all<{ activity_type: string }>()
    expect(activity.results).toHaveLength(1)
  })
})

describe("authenticated settings password reset", () => {
  it("rejects signed-out requests", async () => {
    expect((await reqJson("/api/v2/auth/me/password-reset/request", {})).status).toBe(401)
  })
  it("ignores a supplied recipient and sends only to the authenticated account", async () => {
    const response = await register("settingsreset", "settingsreset@example.com", "old-password-1")
    const { access_token } = await response.json() as { access_token: string }
    const send = vi.fn(async (_message: { to?: string[]; text?: string }) => ({ messageId: "test-reset" }))
    const result = await app.request("/api/v2/auth/me/password-reset/request", {
      method: "POST", headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ email: "someone-else@example.com" }),
    }, { ...env, EMAIL: { send } })
    expect(result.status).toBe(200)
    expect(send).toHaveBeenCalledOnce()
    expect(send.mock.calls[0][0].to).toEqual(["settingsreset@example.com"])
    expect(send.mock.calls[0][0].text).toContain("username=settingsreset")
    const url = new URL(send.mock.calls[0][0].text!.match(/https?:\/\/\S+\/reset-password\?\S+/)![0])
    expect(url.searchParams.get("returnTo")).toBe("/preferences/login-methods")
  })
})


it("consumes one reset link only once even when both requests have validated it", async () => {
  await register("concurrentreset", "concurrentreset@example.com", "original-password-1")
  await seedToken("concurrentreset", "concurrent-link", soon())
  const original = passwordUtil.hashPasswordWerkzeugScrypt
  let arrivals = 0
  let release!: () => void
  const barrier = new Promise<void>(resolve => { release = resolve })
  const hashing = vi.spyOn(passwordUtil, "hashPasswordWerkzeugScrypt").mockImplementation(async value => {
    if (++arrivals === 2) release()
    await barrier
    return original(value)
  })
  try {
    const requests = ["replacement-password-1", "replacement-password-2"].map(new_password => reqJson("/api/v2/auth/password-reset/reset", { token: "concurrent-link", username: "concurrentreset", new_password }))
    const responses = await Promise.all(requests)
    expect(responses.map(r => r.status).sort()).toEqual([200,400])
    const saved=await env.AQUILLA_PG.prepare("SELECT password_hash FROM users WHERE username='concurrentreset'").first<{password_hash:string}>()
    for (const [index,password] of ["replacement-password-1","replacement-password-2"].entries()) {
      expect((await passwordUtil.verifyPassword(password,saved!.password_hash)).isValid).toBe(responses[index].status===200)
    }
    expect(await env.AQUILLA_PG.prepare("SELECT session_version FROM users WHERE username='concurrentreset'").first()).toEqual({session_version:1})
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM password_reset_tokens").first()).toEqual({n:0})
  } finally { hashing.mockRestore() }
})

it("rolls back password, generation and reset-link consumption when a recovery side effect fails", async () => {
  await register("rollbackreset", "rollbackreset@example.com", "original-password-1")
  await seedToken("rollbackreset", "rollback-link", soon())
  const before = await env.AQUILLA_PG.prepare("SELECT password_hash,session_version FROM users WHERE username='rollbackreset'").first()
  await env.AQUILLA_PG.prepare("INSERT INTO api_credentials(id,user_id,name,token_prefix,token_hash,mode) SELECT '00000000-0000-0000-0000-000000000001',id::text,'audit','audit','audit-reset-hash','ask' FROM users WHERE username='rollbackreset'").run()
  // Real PostgreSQL constraint failure after the password UPDATE and token claim.
  await env.AQUILLA_PG.prepare("ALTER TABLE activity_logs ADD CONSTRAINT audit_reject_reset CHECK (activity_type <> 'password_reset_completed')").run()
  try {
    expect((await reqJson("/api/v2/auth/password-reset/reset", { token:"rollback-link", username:"rollbackreset", new_password:"replacement-password-1" })).status).toBe(500)
    expect(await env.AQUILLA_PG.prepare("SELECT password_hash,session_version FROM users WHERE username='rollbackreset'").first()).toEqual(before)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM password_reset_tokens").first()).toEqual({n:1})
    expect(await env.AQUILLA_PG.prepare("SELECT revoked_at FROM api_credentials WHERE token_hash='audit-reset-hash'").first()).toEqual({revoked_at:null})
  } finally { await env.AQUILLA_PG.prepare("ALTER TABLE activity_logs DROP CONSTRAINT audit_reject_reset").run() }
  expect((await reqJson("/api/v2/auth/password-reset/reset", { token:"rollback-link", username:"rollbackreset", new_password:"replacement-password-1" })).status).toBe(200)
  expect(await env.AQUILLA_PG.prepare("SELECT revoked_at IS NOT NULL AS revoked FROM api_credentials WHERE token_hash='audit-reset-hash'").first()).toEqual({revoked:true})
})
