// Auth routes ported from frontier-server/cloudflare/src/routes/auth.ts.
//
// All routes are mounted under `/api/v2/auth/*` by src/index.ts so the
// frontend can target the new auth-worker by flipping VITE_AUTH_BASE without
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
import { GitLabService } from "../services/gitlab"
import { sendPasswordResetEmail } from "../services/email"
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
    if (!c.env.GITLAB_URL) {
      return c.json(
        {
          detail: "GitLab is not configured (missing GITLAB_URL)",
          error: "Registration failed",
        },
        503,
      )
    }
    if (!c.env.GITLAB_ADMIN_TOKEN) {
      return c.json(
        {
          detail: "GitLab is not configured (missing GITLAB_ADMIN_TOKEN)",
          error: "Registration failed",
        },
        503,
      )
    }
    try {
      new URL(String(c.env.GITLAB_URL))
    } catch {
      return c.json(
        {
          detail: `GitLab is misconfigured (invalid GITLAB_URL: ${String(
            c.env.GITLAB_URL,
          )})`,
          error: "Registration failed",
        },
        503,
      )
    }
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

    const existingUser = await c.env.AUTH_DB.prepare(
      "SELECT id FROM users WHERE username = ? OR email = ?",
    )
      .bind(username, email)
      .first<ExistingUserCheck>()
    if (existingUser) {
      return c.json(
        { detail: "User already exists", error: "User already exists" },
        409,
      )
    }

    const gitlabService = new GitLabService(c.env)
    const gitlabUser = await gitlabService.createOrGetUser(
      username,
      email,
      password,
    )

    const passwordHash = await hashPasswordWerkzeugScrypt(password)

    const result = await c.env.AUTH_DB.prepare(
      `INSERT INTO users (username, email, password_hash, gitlab_user_id, gitlab_username, gitlab_token)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        username,
        email,
        passwordHash,
        gitlabUser.id,
        gitlabUser.username,
        gitlabUser.access_token,
      )
      .run()
    if (!result.success) {
      if (gitlabUser.just_created) {
        await gitlabService.deleteUser(gitlabUser.id)
      }
      throw new Error("Failed to create user in database")
    }

    const jwtService = new JWTService(c.env)
    const accessToken = await jwtService.createAccessToken(username)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
      gitlab_token: gitlabUser.access_token,
      gitlab_url: gitlabUser.gitlab_url,
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
          await c.env.AUTH_DB.prepare(
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

    // Best-effort GitLab token refresh. We don't fail login if GitLab is down.
    let gitlabToken = user.gitlab_token || undefined
    let gitlabUrl = c.env.GITLAB_URL
    if (c.env.GITLAB_URL && c.env.GITLAB_ADMIN_TOKEN) {
      try {
        const gitlabService = new GitLabService(c.env)
        const tokenData = await gitlabService.createPersonalAccessToken(
          user.username,
          password,
        )
        gitlabToken = tokenData.access_token
        gitlabUrl = tokenData.gitlab_url
        await c.env.AUTH_DB.prepare(
          "UPDATE users SET gitlab_token = ? WHERE id = ?",
        )
          .bind(gitlabToken, user.id)
          .run()
      } catch (gitlabError) {
        console.error("Failed to refresh GitLab token:", gitlabError)
      }
    }

    const accessToken = await jwtService.createAccessToken(user.username)
    return c.json({
      access_token: accessToken,
      token_type: "bearer",
      gitlab_token: gitlabToken,
      gitlab_url: gitlabUrl,
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
    gitlab_username: user.gitlab_username,
    preferences: user.preferences,
  })
})

auth.get("/gitlab/info", authMiddleware, async (c) => {
  const user = c.get("user")
  try {
    if (!c.env.GITLAB_URL || !c.env.GITLAB_ADMIN_TOKEN) {
      return c.json({ error: "GitLab is not configured" }, 503)
    }
    const gitlabService = new GitLabService(c.env)
    const info = await gitlabService.getUserInfo(
      user.username,
      user.gitlab_user_id,
      user.gitlab_username,
      user.gitlab_token,
    )
    return c.json(info)
  } catch (error) {
    console.error("GitLab info error:", error)
    return c.json({ error: "Failed to get GitLab info" }, 500)
  }
})

auth.get("/gitlab/projects/count", authMiddleware, async (c) => {
  const user = c.get("user")
  if (!user.gitlab_user_id) {
    return c.json({ error: "GitLab info not found" }, 404)
  }
  try {
    if (!c.env.GITLAB_URL || !c.env.GITLAB_ADMIN_TOKEN) {
      return c.json({ error: "GitLab is not configured" }, 503)
    }
    const gitlabService = new GitLabService(c.env)
    const count = await gitlabService.getUserProjectsCount(user.gitlab_user_id)
    return c.json({ project_count: count })
  } catch (error) {
    console.error("GitLab projects count error:", error)
    return c.json({ error: "Failed to get projects count" }, 500)
  }
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
    const logs = await c.env.AUTH_DB.prepare(
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
      const user = await c.env.AUTH_DB.prepare(
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
      await c.env.AUTH_DB.prepare(
        `INSERT OR REPLACE INTO password_reset_tokens (user_id, token, expires_at)
         VALUES (?, ?, ?)`,
      )
        .bind(user.id, token, expiresAt.toISOString())
        .run()

      const encodedUsername = encodeURIComponent(user.username)
      const baseUrl = c.env.BASE_URL || "https://codex-web.pages.dev"
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
      const user = await c.env.AUTH_DB.prepare(
        "SELECT id FROM users WHERE username = ?",
      )
        .bind(username)
        .first<{ id: number }>()
      if (!user) {
        return c.json({ error: "Invalid token" }, 400)
      }

      const resetToken = await c.env.AUTH_DB.prepare(
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
        await c.env.AUTH_DB.prepare(
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
      const user = await c.env.AUTH_DB.prepare(
        "SELECT id, gitlab_user_id FROM users WHERE username = ?",
      )
        .bind(username)
        .first<{ id: number; gitlab_user_id: number | null }>()
      if (!user) {
        return c.json({ error: "Invalid token" }, 400)
      }

      const resetToken = await c.env.AUTH_DB.prepare(
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
        await c.env.AUTH_DB.prepare(
          "DELETE FROM password_reset_tokens WHERE user_id = ?",
        )
          .bind(user.id)
          .run()
        return c.json({ error: "Token expired" }, 400)
      }

      const passwordHash = await hashPasswordWerkzeugScrypt(new_password)
      await c.env.AUTH_DB.prepare(
        "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      )
        .bind(passwordHash, user.id)
        .run()
      await c.env.AUTH_DB.prepare(
        "DELETE FROM password_reset_tokens WHERE user_id = ?",
      )
        .bind(user.id)
        .run()

      if (user.gitlab_user_id && c.env.GITLAB_URL && c.env.GITLAB_ADMIN_TOKEN) {
        try {
          const gitlabService = new GitLabService(c.env)
          await gitlabService.updateUserPassword(
            user.gitlab_user_id,
            new_password,
          )
        } catch (gitlabError) {
          console.error("Failed to update GitLab password:", gitlabError)
        }
      }
      return c.json({ message: "Password reset successful" })
    } catch (error) {
      console.error("Password reset error:", error)
      return c.json({ error: "Failed to reset password" }, 500)
    }
  },
)

export default auth
