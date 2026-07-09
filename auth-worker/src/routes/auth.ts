// Auth routes ported from frontier-server/cloudflare/src/routes/auth.ts.
//
// All routes are mounted under `/api/v2/auth/*` by src/index.ts so the
// frontend can target aquilla-identity by flipping VITE_AUTH_BASE without
// touching the rest of the request shape.
//
// Side-by-side writer model: rows land in the same frontier-db-v2 the legacy
// frontier-server uses, with the same SECRET_KEY and Werkzeug-scrypt password
// format, so JWTs and user records are interchangeable.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import type {
  AuthHonoEnv,
} from "../middleware/auth"
import { authMiddleware } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import { sendPasswordResetEmail, sendWelcomeEmail } from "../services/email"
import {
  hashPasswordWerkzeugScrypt,
  verifyPassword,
} from "../utils/password"

const auth = new Hono<AuthHonoEnv>()

const registerSchema = z.object({
  username: z.string().min(3).max(50),
  email: z.string().email(),
  password: z.string().min(8),
})

const loginSchema = z.object({
  // Can be username or email.
  username: z.string(),
  password: z.string(),
})

const passwordResetRequestSchema = z.object({
  email: z.string().email(),
})

const passwordResetSchema = z.object({
  token: z.string(),
  username: z.string(),
  new_password: z.string().min(8),
})

const verifyResetTokenSchema = z.object({
  token: z.string(),
  username: z.string(),
})

interface ExistingUserCheck {
  id: number
}

interface ResetTokenRow {
  expires_at: string
}

auth.post("/register", zValidator("json", registerSchema), async (c) => {
  const { username, email, password } = c.req.valid("json")

  try {
    if (!c.env.SECRET_KEY || !c.env.ALGORITHM) {
      return c.json(
        {
          detail:
            "Authentication is not configured (missing SECRET_KEY/ALGORITHM for JWT signing)",
          error: "Registration failed",
        },
        503,
      )
    }

    // Uniqueness is case-insensitive (AQU-340): reject `ryan` when `Ryan`
    // already exists so we never mint case-twin accounts that then collide in
    // lookups/@mentions/audit trails. The row still stores the exact casing the
    // user typed (see INSERT below) — case-insensitive functionally, but the
    // chosen casing is preserved for display. Email is likewise compared
    // case-insensitively (it is the closest sibling identifier).
    const existingUser = await c.env.AQUILLA_PG.prepare(
      "SELECT id FROM users WHERE LOWER(username) = LOWER(?) OR LOWER(email) = LOWER(?)",
    )
      .bind(username, email)
      .first<ExistingUserCheck>()
    if (existingUser) {
      return c.json(
        { detail: "User already exists", error: "User already exists" },
        409,
      )
    }

    const passwordHash = await hashPasswordWerkzeugScrypt(password)

    const result = await c.env.AQUILLA_PG.prepare(
      `INSERT INTO users (username, email, password_hash)
       VALUES (?, ?, ?)`,
    )
      .bind(username, email, passwordHash)
      .run()
    if (!result.success) {
      throw new Error("Failed to create user in database")
    }

    // Mint a soft email-verification token and fold the verify link into the
    // welcome email. Best-effort: a failure here must never break registration.
    let verifyUrl: string | undefined
    try {
      const created = await c.env.AQUILLA_PG.prepare(
        "SELECT id FROM users WHERE username = ?",
      )
        .bind(username)
        .first<{ id: number }>()
      if (created) {
        const verifyToken = crypto.randomUUID().replace(/-/g, "")
        const expiresAt = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000,
        ).toISOString()
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO email_verification_tokens (user_id, token, expires_at)
           VALUES (?, ?, ?)`,
        )
          .bind(created.id, verifyToken, expiresAt)
          .run()
        const baseUrl = c.env.BASE_URL || "https://aquilla.app"
        verifyUrl = `${baseUrl}/verify-email?token=${verifyToken}`
      }
    } catch (err) {
      console.warn("[verify] failed to mint verification token:", err)
    }

    // Best-effort welcome email (now carrying the verify link). sendWelcomeEmail
    // no-ops without the EMAIL binding and swallows its own errors, so this can
    // never fail or delay registration. waitUntil keeps a slow send off the
    // response path in prod; the test harness has no ExecutionContext (the
    // getter throws), so we let the promise settle on its own there.
    const welcomePromise = sendWelcomeEmail(c.env, email, username, verifyUrl)
    try {
      c.executionCtx.waitUntil(welcomePromise)
    } catch {
      void welcomePromise
    }

    const jwtService = new JWTService(c.env)
    const accessToken = await jwtService.createAccessToken(username)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
    })
  } catch (error) {
    console.error("Registration error:", error)
    const msg = error instanceof Error ? error.message : String(error)

    if (
      msg.includes("UNIQUE constraint failed: users.username") ||
      msg.includes("UNIQUE constraint failed: users.email") ||
      msg.includes("User already exists")
    ) {
      return c.json(
        { detail: "User already exists", error: "User already exists" },
        409,
      )
    }
    if (msg.includes("409")) {
      return c.json({ detail: msg, error: msg }, 409)
    }

    const envName = String(c.env.ENVIRONMENT || "").toLowerCase()
    const isProd = envName === "production" || envName === "prod"
    const detail = isProd ? "Registration failed" : msg || "Registration failed"
    return c.json({ detail, error: "Registration failed" }, 500)
  }
})

// Login. Supports both JSON and form-encoded bodies so OAuth2-shaped clients
// keep working — matches the legacy frontier-server.
auth.post("/token", async (c) => {
  const contentType = c.req.header("content-type") || ""
  let body: { username?: string; password?: string } = {}

  try {
    if (contentType.includes("application/json")) {
      body = (await c.req.json()) as typeof body
    } else if (
      contentType.includes("application/x-www-form-urlencoded") ||
      contentType.includes("multipart/form-data")
    ) {
      const parsed = await c.req.parseBody()
      body = {
        username:
          typeof parsed.username === "string" ? parsed.username : undefined,
        password:
          typeof parsed.password === "string" ? parsed.password : undefined,
      }
    } else {
      body = (await c.req.json()) as typeof body
    }
  } catch {
    // Validation below returns 400 on missing fields.
  }

  const validated = loginSchema.safeParse(body)
  if (!validated.success) {
    return c.json({ error: "Invalid request body" }, 400)
  }
  const { username, password } = validated.data

  try {
    if (!c.env.SECRET_KEY || !c.env.ALGORITHM) {
      return c.json(
        {
          error:
            "Authentication is not configured (missing SECRET_KEY/ALGORITHM for JWT signing)",
        },
        503,
      )
    }

    const jwtService = new JWTService(c.env)
    let user = await jwtService.getUserByUsername(username)
    if (!user) {
      user = await jwtService.getUserByEmail(username)
    }
    if (!user) {
      return c.json({ error: "Incorrect username/email or password" }, 401)
    }

    let isValidPassword = false
    try {
      const result = await verifyPassword(password, user.password_hash)
      isValidPassword = result.isValid
      if (result.isValid && result.shouldRehashToWerkzeugScrypt) {
        try {
          const newHash = await hashPasswordWerkzeugScrypt(password)
          await c.env.AQUILLA_PG.prepare(
            "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          )
            .bind(newHash, user.id)
            .run()
          user.password_hash = newHash
        } catch (rehashError) {
          console.error("Failed to rehash password to scrypt:", rehashError)
        }
      }
    } catch (e) {
      console.error("Password verification failed:", e)
      isValidPassword = false
    }
    if (!isValidPassword) {
      return c.json({ error: "Incorrect username/email or password" }, 401)
    }

    const accessToken = await jwtService.createAccessToken(user.username)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
    })
  } catch (error) {
    console.error("Login error:", error)
    return c.json({ error: "Login failed" }, 500)
  }
})

auth.get("/me", authMiddleware, async (c) => {
  const user = c.get("user")
  return c.json({
    id: user.id,
    username: user.username,
    email: user.email,
    preferences: user.preferences,
  })
})

// FRO-436: Self-update gate for the authenticated user.
//
// USERNAME is intentionally immutable for self-service users. Come and See
// (the translation-programme manager) centrally tracks translator usernames
// and coordinates password resets; a translator changing their own username
// would silently break that tracking. The gate is enforced here rather than
// at the DB layer so the error message is user-facing and precise.
//
// CONFIGURABLE GATE — org setting key `usernameChangeMinRole`:
//   Unset (or null)  → nobody can self-change their username (the default and
//                       the correct production posture for managed programmes).
//   Set to a role level (e.g. 700) → only org members with that effective org
//                       role or above may change their own username. Follow the
//                       exportMinRole pattern in org-settings.ts if you need to
//                       implement this path.
//
// PASSWORD changes are NOT offered here — see SWARM-TODO below.
//
// SWARM-TODO (password-reset policy): Decide whether self-serve password reset
// (the existing /password-reset/request email-token flow) is sufficient, or
// whether org Maintainer/Owner should be able to trigger a reset on behalf of
// a subordinate user. If the latter, add a POST /api/v2/orgs/:orgId/members/:userId/reset-password
// route gated at org MAINTAINER (600). Leave this decision to Ryder — do not
// build it without sign-off.
//
// SWARM-TODO (admin credential reset): There is no route today for an org
// Maintainer/Owner to reset a subordinate user's password. The email-token flow
// (POST /api/v2/auth/password-reset/request) is self-serve only (requires the
// user's email inbox). An org-managed reset path is a deliberate product
// decision: if the programme manager needs to issue a new password to a
// translator who has lost email access, a new admin route is needed. Track
// separately.

const patchMeSchema = z.object({
  // Only safe, non-identity fields may be updated by the user themselves.
  // Username and password fields are explicitly rejected below even if they
  // somehow pass schema validation, to make the policy unmistakable.
  preferences: z.record(z.string(), z.unknown()).optional(),
  // Explicitly reject identity-change fields so a client sending them gets
  // a clear 403 rather than a silent no-op.
  username: z.string().optional(),
  password: z.string().optional(),
  new_password: z.string().optional(),
})

auth.patch("/me", authMiddleware, zValidator("json", patchMeSchema), async (c) => {
  const body = c.req.valid("json")
  const user = c.get("user")

  // FRO-436: block username self-change unconditionally.
  // Configurable override via org setting `usernameChangeMinRole` is
  // documented above but not implemented — the default (block) is correct
  // for all current managed translation programmes.
  if (body.username !== undefined) {
    return c.json(
      {
        error:
          "Username cannot be changed by the user. Contact your programme manager to update credentials.",
      },
      403,
    )
  }

  // FRO-436: password self-change is not offered here.
  // Use POST /api/v2/auth/password-reset/request (email-token flow).
  // See SWARM-TODO above for the org-managed reset path.
  if (body.password !== undefined || body.new_password !== undefined) {
    return c.json(
      {
        error:
          "Password cannot be changed here. Use the password-reset email link, or contact your programme manager.",
      },
      403,
    )
  }

  // Safe update: preferences only.
  if (body.preferences !== undefined) {
    const preferencesJson = JSON.stringify(body.preferences)
    await c.env.AQUILLA_PG.prepare(
      "UPDATE users SET preferences = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(preferencesJson, user.id)
      .run()
  }

  // Re-fetch to return the canonical record.
  const updated = await c.env.AQUILLA_PG.prepare(
    "SELECT id, username, email, preferences FROM users WHERE id = ?",
  )
    .bind(user.id)
    .first<{ id: number; username: string; email: string; preferences: string }>()

  if (!updated) return c.json({ error: "user not found" }, 404)

  let preferences: Record<string, unknown> = {}
  try {
    preferences = JSON.parse(updated.preferences) as Record<string, unknown>
  } catch {
    preferences = {}
  }

  return c.json({
    id: updated.id,
    username: updated.username,
    email: updated.email,
    preferences,
  })
})

const verifyEmailSchema = z.object({ token: z.string().min(8) })

// POST /api/v2/auth/verify-email — public; the token is the authorization.
// Soft verification: stamps users.email_verified_at. The token is single-use
// (deleted on success), so a second click returns 404 ("already used").
auth.post("/verify-email", zValidator("json", verifyEmailSchema), async (c) => {
  const { token } = c.req.valid("json")
  const row = await c.env.AQUILLA_PG.prepare(
    "SELECT user_id, expires_at FROM email_verification_tokens WHERE token = ?",
  )
    .bind(token)
    .first<{ user_id: number; expires_at: string }>()
  if (!row) {
    return c.json({ error: "Invalid or already-used verification link" }, 404)
  }
  if (new Date(row.expires_at) < new Date()) {
    await c.env.AQUILLA_PG.prepare(
      "DELETE FROM email_verification_tokens WHERE token = ?",
    )
      .bind(token)
      .run()
    return c.json({ error: "Verification link expired" }, 410)
  }
  await c.env.AQUILLA_PG.prepare(
    "UPDATE users SET email_verified_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(row.user_id)
    .run()
  // Clear all of this user's verification tokens — single-use + cleanup.
  await c.env.AQUILLA_PG.prepare(
    "DELETE FROM email_verification_tokens WHERE user_id = ?",
  )
    .bind(row.user_id)
    .run()
  return c.json({ verified: true })
})

interface ActivityLogRow {
  timestamp: string
  activity_type: string | null
  description: string | null
  activity_metadata: string | null
}

auth.get("/activity-log", authMiddleware, async (c) => {
  const user = c.get("user")
  try {
    const logs = await c.env.AQUILLA_PG.prepare(
      `SELECT timestamp, activity_type, description, activity_metadata
       FROM activity_logs
       WHERE user_id = ?
       ORDER BY timestamp DESC
       LIMIT 100`,
    )
      .bind(user.id)
      .all<ActivityLogRow>()
    return c.json(
      logs.results.map((log) => ({
        timestamp: log.timestamp,
        activity_type: log.activity_type,
        description: log.description,
        metadata: log.activity_metadata
          ? safeParseJson(log.activity_metadata)
          : null,
      })),
    )
  } catch (error) {
    console.error("Activity log error:", error)
    return c.json([])
  }
})

function safeParseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

auth.post(
  "/password-reset/request",
  zValidator("json", passwordResetRequestSchema),
  async (c) => {
    const { email } = c.req.valid("json")
    try {
      const user = await c.env.AQUILLA_PG.prepare(
        "SELECT id, username FROM users WHERE email = ?",
      )
        .bind(email)
        .first<{ id: number; username: string }>()
      if (!user) {
        // Don't disclose whether the email is registered.
        return c.json({ message: "Password reset link sent to your email" })
      }

      const token = crypto.randomUUID()
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000)
      await c.env.AQUILLA_PG.prepare(
        `INSERT INTO password_reset_tokens (user_id, token, expires_at)
         VALUES (?, ?, ?)
         ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, expires_at = excluded.expires_at`,
      )
        .bind(user.id, token, expiresAt.toISOString())
        .run()

      const encodedUsername = encodeURIComponent(user.username)
      const baseUrl = c.env.BASE_URL || "https://aquilla.app"
      const resetUrl = `${baseUrl}/reset-password?token=${token}&username=${encodedUsername}`
      await sendPasswordResetEmail(c.env, email, resetUrl)

      return c.json({ message: "Password reset link sent to your email" })
    } catch (error) {
      console.error("Password reset request error:", error)
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error"
      return c.json(
        { error: `Failed to send reset email: ${errorMessage}` },
        500,
      )
    }
  },
)

auth.post(
  "/password-reset/verify",
  zValidator("json", verifyResetTokenSchema),
  async (c) => {
    const { token, username } = c.req.valid("json")
    try {
      const user = await c.env.AQUILLA_PG.prepare(
        "SELECT id FROM users WHERE username = ?",
      )
        .bind(username)
        .first<{ id: number }>()
      if (!user) {
        return c.json({ error: "Invalid token" }, 400)
      }

      const resetToken = await c.env.AQUILLA_PG.prepare(
        `SELECT expires_at FROM password_reset_tokens
         WHERE user_id = ? AND token = ?`,
      )
        .bind(user.id, token)
        .first<ResetTokenRow>()
      if (!resetToken) {
        return c.json({ error: "Invalid token" }, 400)
      }

      const expiresAt = new Date(resetToken.expires_at)
      if (expiresAt < new Date()) {
        await c.env.AQUILLA_PG.prepare(
          "DELETE FROM password_reset_tokens WHERE user_id = ?",
        )
          .bind(user.id)
          .run()
        return c.json({ error: "Token expired" }, 400)
      }
      return c.json({ message: "Token is valid" })
    } catch (error) {
      console.error("Token verification error:", error)
      return c.json({ error: "Invalid token" }, 400)
    }
  },
)

auth.post(
  "/password-reset/reset",
  zValidator("json", passwordResetSchema),
  async (c) => {
    const { token, username, new_password } = c.req.valid("json")
    try {
      const user = await c.env.AQUILLA_PG.prepare(
        "SELECT id FROM users WHERE username = ?",
      )
        .bind(username)
        .first<{ id: number }>()
      if (!user) {
        return c.json({ error: "Invalid token" }, 400)
      }

      const resetToken = await c.env.AQUILLA_PG.prepare(
        `SELECT expires_at FROM password_reset_tokens
         WHERE user_id = ? AND token = ?`,
      )
        .bind(user.id, token)
        .first<ResetTokenRow>()
      if (!resetToken) {
        return c.json({ error: "Invalid token" }, 400)
      }
      const expiresAt = new Date(resetToken.expires_at)
      if (expiresAt < new Date()) {
        await c.env.AQUILLA_PG.prepare(
          "DELETE FROM password_reset_tokens WHERE user_id = ?",
        )
          .bind(user.id)
          .run()
        return c.json({ error: "Token expired" }, 400)
      }

      const passwordHash = await hashPasswordWerkzeugScrypt(new_password)
      await c.env.AQUILLA_PG.prepare(
        "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(passwordHash, user.id)
        .run()
      await c.env.AQUILLA_PG.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id = ?",
      )
        .bind(user.id)
        .run()

      return c.json({ message: "Password reset successful" })
    } catch (error) {
      console.error("Password reset error:", error)
      return c.json({ error: "Failed to reset password" }, 500)
    }
  },
)

export default auth
