// Auth routes ported from frontier-server/cloudflare/src/routes/auth.ts.
//
// All routes are mounted under `/api/v2/auth/*` by src/index.ts so the
// frontend can target aquilla-identity by flipping VITE_AUTH_BASE without
// touching the rest of the request shape.
//
// Neon is authoritative. AQU-713 adds a one-way, read-only bridge for a legacy
// identity only when no case-insensitive Neon identity exists.

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
import {
  countRecentEvents,
  ipIdentifier,
  loginIdentifier,
  LOGIN_MAX_FAILURES_PER_IDENTIFIER,
  LOGIN_MAX_FAILURES_PER_IP,
  recordAuthEvent,
  REGISTER_MAX_PER_IP,
  RESET_REQUEST_MAX_PER_IDENTIFIER,
} from "../utils/rate-limit"
import {
  LegacyUserMigrationError,
  migrateLegacyUserCandidate,
  migrateLegacyUserForLogin,
  verifyLegacyUserForLogin,
  type LegacyMigrationRuntime,
} from "../services/legacy-user-migration"
import {
  hasLegacyIdentityCollision,
  type FrontierD1Config,
} from "../services/frontier-d1"

/** Append to activity_logs. Best-effort: a logging failure is swallowed so it
 *  never fails the caller's request; awaited (not fire-and-forget) so the
 *  audit trail is durable rather than racing an early Worker termination. */
async function logActivity(
  db: AquillaDb,
  userId: number,
  activityType: string,
  description: string,
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO activity_logs (user_id, activity_type, description) VALUES (?, ?, ?)",
      )
      .bind(userId, activityType, description)
      .run()
  } catch (err) {
    console.warn("[activity-log] insert failed (non-fatal):", err)
  }
}

/** CF-Connecting-IP is set by Cloudflare at the edge and not client-settable. */
function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return c.req.header("CF-Connecting-IP") || "unknown"
}

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
  // Opt-in web handshake: establish valid D1 credentials before telling the
  // browser that the continuation will contact GitLab. Other API clients keep
  // the original one-request login behavior.
  migration_handshake: z.boolean().optional(),
  continue_migration: z.boolean().optional(),
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

function legacyD1Config(
  env: AuthHonoEnv["Bindings"],
): FrontierD1Config | null {
  if (String(env.LEGACY_USER_MIGRATION_ENABLED).toLowerCase() !== "true") {
    return null
  }
  const accountId = env.FRONTIER_D1_ACCOUNT_ID?.trim()
  const databaseId = env.FRONTIER_D1_DATABASE_ID?.trim()
  const apiToken = env.FRONTIER_D1_API_TOKEN?.trim()
  if (!accountId || !databaseId || !apiToken) {
    throw new LegacyUserMigrationError(
      "dependency",
      "legacy identity protection is enabled but D1 is not fully configured",
    )
  }
  return {
    accountId,
    databaseId,
    apiToken,
    apiBaseUrl: env.FRONTIER_D1_API_BASE_URL?.trim() || undefined,
  }
}

function legacyMigrationRuntime(env: AuthHonoEnv["Bindings"]): LegacyMigrationRuntime | null {
  const d1 = legacyD1Config(env)
  if (!d1) return null

  const gitlabUrl = env.GITLAB_URL?.trim().replace(/\/+$/, "")
  const gitlabToken = env.GITLAB_ADMIN_TOKEN?.trim()
  if (!gitlabUrl || !gitlabToken) {
    throw new LegacyUserMigrationError(
      "dependency",
      "legacy user migration is enabled but GitLab is not fully configured",
    )
  }
  return {
    d1,
    gitlab: { gitlabUrl, gitlabToken, accessToken: "" },
  }
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

    // [Pen test] Auth & session mgmt (2026-07-27): unthrottled, so a scripted
    // caller could flood account creation or use the 409 "User already
    // exists" response as a fast per-IP enumeration oracle across many
    // guessed emails/usernames. Recorded regardless of outcome (like
    // password-reset-request) and checked before the DB uniqueness lookup.
    const ipIdent = ipIdentifier(clientIp(c))
    const recentRegistrations = await countRecentEvents(
      c.env.AQUILLA_PG,
      "register",
      ipIdent,
      { onlyFailures: false },
    )
    if (recentRegistrations >= REGISTER_MAX_PER_IP) {
      return c.json(
        { detail: "Too many registration attempts. Please try again later.", error: "Too many attempts" },
        429,
      )
    }
    await recordAuthEvent(c.env.AQUILLA_PG, "register", ipIdent, true)

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

    // AQU-713: while the one-way identity bridge is enabled, D1 remains the
    // authority for legacy identity reservations. Reject either a legacy
    // username or legacy email before hashing or inserting anything into the
    // Neon users table. The response deliberately matches the Neon duplicate
    // response so callers cannot distinguish which datastore owns the identity.
    try {
      const d1 = legacyD1Config(c.env)
      if (d1 && await hasLegacyIdentityCollision(d1, username, email)) {
        return c.json(
          { detail: "User already exists", error: "User already exists" },
          409,
        )
      }
    } catch {
      // Fail closed: creating an identity while the legacy reservation source
      // is unavailable could permanently shadow a user awaiting JIT migration.
      // Keep logs free of submitted identifiers, credentials, and raw errors.
      console.error(
        "[legacy-user-migration] registration identity check unavailable",
      )
      return c.json(
        {
          detail: "Registration is temporarily unavailable. Please try again.",
          error: "Registration temporarily unavailable",
        },
        503,
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
        await logActivity(c.env.AQUILLA_PG, created.id, "register", "Account created")
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
      msg.includes("duplicate key value violates unique constraint") ||
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
  let body: {
    username?: string
    password?: string
    migration_handshake?: boolean
    continue_migration?: boolean
  } = {}

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
  const {
    username,
    password,
    migration_handshake: migrationHandshake,
    continue_migration: continueMigration,
  } = validated.data
  const identifier = loginIdentifier(username)
  const ipIdent = ipIdentifier(clientIp(c))

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

    // [Pen test] Auth & session mgmt (2026-07-20): neither this endpoint nor
    // /register nor /password-reset/request had any attempt limiting —
    // credential stuffing / password guessing could run unthrottled. Check
    // BEFORE touching the DB for the user lookup so a locked-out caller can't
    // still use this endpoint as a username-enumeration oracle via timing.
    const [identifierFailures, ipFailures] = await Promise.all([
      countRecentEvents(c.env.AQUILLA_PG, "login", identifier, { onlyFailures: true }),
      countRecentEvents(c.env.AQUILLA_PG, "login", ipIdent, { onlyFailures: true }),
    ])
    if (
      identifierFailures >= LOGIN_MAX_FAILURES_PER_IDENTIFIER ||
      ipFailures >= LOGIN_MAX_FAILURES_PER_IP
    ) {
      return c.json(
        { error: "Too many login attempts. Please try again later." },
        429,
      )
    }

    const jwtService = new JWTService(c.env)
    let user = await jwtService.getUserByUsername(username)
    if (!user) {
      user = await jwtService.getUserByEmail(username)
    }
    let passwordAlreadyVerified = false
    if (!user) {
      try {
        const runtime = legacyMigrationRuntime(c.env)
        if (runtime) {
          const source = migrationHandshake
            ? await verifyLegacyUserForLogin(username, password, runtime)
            : null
          if (source && source.gitlab_user_id == null) {
            throw new LegacyUserMigrationError(
              "unresolved-access",
              "legacy user has no GitLab identity",
            )
          }
          if (source && !continueMigration) {
            return c.json({ status: "migration_required" }, 202)
          }
          const migrated = migrationHandshake
            ? source
              ? await migrateLegacyUserCandidate(
                  c.env.AQUILLA_PG,
                  source,
                  runtime,
                  "jit",
                )
              : null
            : await migrateLegacyUserForLogin(
                c.env.AQUILLA_PG,
                username,
                password,
                runtime,
              )
          if (migrated) {
            user = await jwtService.getUserByUsername(migrated.username)
            if (!user) {
              throw new LegacyUserMigrationError(
                "dependency",
                "migrated Neon identity could not be loaded",
              )
            }
            // Only a row created by this exact request can reuse the password
            // verification performed against the byte-identical copied hash.
            // A concurrent/idempotent result is re-verified against Neon below.
            passwordAlreadyVerified = migrated.created
          }
        }
      } catch (error) {
        if (error instanceof LegacyUserMigrationError) {
          console.error("[legacy-user-migration] login migration failed", {
            code: error.code,
            reason: error.message,
          })
          if (error.code === "conflict") {
            return c.json(
              { error: "Account migration requires support" },
              409,
            )
          }
          return c.json(
            { error: "Account migration is temporarily unavailable. Please try again." },
            503,
          )
        }
        throw error
      }
    }
    if (!user) {
      await Promise.all([
        recordAuthEvent(c.env.AQUILLA_PG, "login", identifier, false),
        recordAuthEvent(c.env.AQUILLA_PG, "login", ipIdent, false),
      ])
      return c.json({ error: "Incorrect username/email or password" }, 401)
    }

    let isValidPassword = passwordAlreadyVerified
    try {
      const result = passwordAlreadyVerified
        ? { isValid: true, shouldRehashToWerkzeugScrypt: false }
        : await verifyPassword(password, user.password_hash)
      isValidPassword = result.isValid
      if (!passwordAlreadyVerified && result.isValid && result.shouldRehashToWerkzeugScrypt) {
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
      await Promise.all([
        recordAuthEvent(c.env.AQUILLA_PG, "login", identifier, false),
        recordAuthEvent(c.env.AQUILLA_PG, "login", ipIdent, false),
        logActivity(c.env.AQUILLA_PG, user.id, "login_failed", "Incorrect password"),
      ])
      return c.json({ error: "Incorrect username/email or password" }, 401)
    }

    await Promise.all([
      recordAuthEvent(c.env.AQUILLA_PG, "login", identifier, true),
      recordAuthEvent(c.env.AQUILLA_PG, "login", ipIdent, true),
      logActivity(c.env.AQUILLA_PG, user.id, "login", "Signed in"),
    ])

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

// AQU-436: Self-update gate for the authenticated user.
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

  // AQU-436: block username self-change unconditionally.
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

  // AQU-436: password self-change is not offered here.
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
      // [Pen test] Auth & session mgmt (2026-07-20): this endpoint had no
      // limit on how many reset emails could be triggered for one address —
      // an easy way to spam a victim's inbox. Check + record BEFORE the user
      // lookup and always record the same way regardless of whether the
      // address is registered, so a prober can't distinguish "throttled" from
      // "not registered" from timing/behavior — the response is identical
      // either way (see the two `!user || throttled` branches below).
      const identifier = loginIdentifier(email)
      const recentRequests = await countRecentEvents(
        c.env.AQUILLA_PG,
        "password_reset_request",
        identifier,
        { onlyFailures: false },
      )
      const throttled = recentRequests >= RESET_REQUEST_MAX_PER_IDENTIFIER
      await recordAuthEvent(c.env.AQUILLA_PG, "password_reset_request", identifier, true)

      const user = await c.env.AQUILLA_PG.prepare(
        "SELECT id, username FROM users WHERE email = ?",
      )
        .bind(email)
        .first<{ id: number; username: string }>()
      if (!user || throttled) {
        // Don't disclose whether the email is registered, and don't disclose
        // that the request was throttled either — same message either way.
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
      // [Pen test] Auth & session mgmt (2026-07-20): a delivery failure here
      // used to fall through to the catch below and return a 500 with an
      // error message — distinguishable from the generic 200 an unregistered
      // address gets, i.e. a secondary user-enumeration oracle (observable
      // whenever the email provider hiccups). The token is already minted and
      // usable via the emailed link regardless of whether the SEND itself
      // succeeds, so a delivery failure shouldn't change the response.
      try {
        await sendPasswordResetEmail(c.env, email, resetUrl)
      } catch (err) {
        console.warn("[password-reset] email send failed (non-fatal):", err)
      }
      await logActivity(c.env.AQUILLA_PG, user.id, "password_reset_requested", "Password reset email sent")

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
      // [Pen test] Auth & session mgmt (2026-07-20): stamp password_changed_at
      // alongside the hash. authMiddleware rejects any access token whose
      // `iat` predates this timestamp, so every access token issued before
      // this reset — including one an attacker stole — stops working
      // immediately instead of remaining valid for up to 30 more days.
      await c.env.AQUILLA_PG.prepare(
        "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP, password_changed_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(passwordHash, user.id)
        .run()
      await c.env.AQUILLA_PG.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id = ?",
      )
        .bind(user.id)
        .run()
      await logActivity(c.env.AQUILLA_PG, user.id, "password_reset_completed", "Password changed via reset link")

      return c.json({ message: "Password reset successful" })
    } catch (error) {
      console.error("Password reset error:", error)
      return c.json({ error: "Failed to reset password" }, 500)
    }
  },
)

export default auth
