import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"

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

async function seedToken(username: string, token: string, expiresAt: string): Promise<void> {
  const u = await env.AQUILLA_PG.prepare("SELECT id FROM users WHERE username = ?")
    .bind(username)
    .first<{ id: number }>()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)",
  )
    .bind(u!.id, token, expiresAt)
    .run()
}

const soon = () => new Date(Date.now() + 3600_000).toISOString()

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
