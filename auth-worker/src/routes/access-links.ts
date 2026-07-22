// AQU-626: authenticated per-user deep links + PIN (fresh-browser / diode-zone
// flow).
//
// Mounted at /api/v2/access-links in src/index.ts. Three routes:
//
//   POST /api/v2/access-links              mint a per-user link + PIN (authed,
//                                          project_lead+ on the target project)
//   POST /api/v2/access-links/:token/redeem   PUBLIC — verify PIN, mint a JWT for
//                                          the bound account, return it
//   POST /api/v2/access-links/:token/revoke   authed — soft-kill a link
//
// Design (decided on AQU-626, "simple, robust, effective, maintained"):
//   * A link binds ONE pre-provisioned account to ONE project. It does not
//     create users — the programme manager provisions translator accounts
//     out-of-band (see auth.ts "Come and See" note) and mints a link per user.
//   * The PIN is the only credential; it is scrypt-hashed exactly like a
//     password (reusing utils/password.ts), never stored in plaintext.
//   * Every redemption failure — unknown token, revoked, expired, locked, or
//     wrong PIN — returns ONE indistinguishable 401. A wrong PIN behaves like a
//     dead link: no oracle to enumerate tokens or confirm PIN correctness.
//   * failed_attempts + locked_until throttle online guessing; with scrypt this
//     makes a short numeric PIN infeasible to brute-force.
//   * The link is REUSABLE — no single-use stamp — so re-opening it after a
//     browser wipe works identically (acceptance criterion 3). revoked_at
//     soft-kills a leaked link.
//   * The bound account's project membership is ensured AT MINT (max-wins,
//     capped at contributor) so redemption is pure authentication and the
//     workspace's normal sync-token path grants read/write on arrival.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import {
  INVITE_MIN_ROLE,
  LINK_ROLE_CAP,
  ROLE,
  type ProjectAccessLinkRow,
} from "../types"
import { resolveProjectRole, isLinkRoleLevel } from "../services/project-permissions"
import { hashPasswordWerkzeugScrypt, verifyPasswordWerkzeugScrypt } from "../utils/password"

const accessLinks = new Hono<AuthHonoEnv>()

// 90-day default lifetime. Longer than the 30-day invite TTL because a diode
// deployment is a standing arrangement, not a one-off join; still bounded so a
// forgotten link eventually dies. Override with `expiresAt` at mint time.
const DEFAULT_LINK_TTL_MS = 90 * 24 * 60 * 60 * 1000

// Online-guessing throttle. After MAX_FAILED_ATTEMPTS wrong PINs the link locks
// for LOCKOUT_MS and redeems as dead until the window passes. A correct PIN
// resets the counter.
const MAX_FAILED_ATTEMPTS = 5
const LOCKOUT_MS = 15 * 60 * 1000

// One error for every failure path so a wrong PIN is indistinguishable from a
// dead link (no token/PIN oracle).
const DEAD_LINK = { error: "This link is invalid or has expired." } as const

function clampLinkRole(level: number): number {
  let n = level
  if (n > LINK_ROLE_CAP) n = LINK_ROLE_CAP
  if (n < ROLE.VIEWER) n = ROLE.VIEWER
  if (!isLinkRoleLevel(n)) n = LINK_ROLE_CAP
  return n
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/access-links — mint a per-user link + PIN.
//
// Body: { projectId, userId, pin, roleLevel?, expiresAt? }
// Caller must hold project_lead+ on the project. The target user must already
// exist (accounts are provisioned out-of-band). Membership is ensured here so
// redemption is pure auth.
// ──────────────────────────────────────────────────────────────────────────

const createSchema = z.object({
  projectId: z.string().min(1).max(256),
  userId: z.number().int().positive(),
  // Numeric PIN, 4–12 digits. Kept simple and typeable on a phone; brute-force
  // resistance comes from scrypt + lockout, not PIN length.
  pin: z.string().regex(/^\d{4,12}$/, "PIN must be 4–12 digits"),
  roleLevel: z.number().int().min(100).max(700).optional(),
  expiresAt: z.string().datetime().optional(),
})

accessLinks.post("/", authMiddleware, zValidator("json", createSchema), async (c) => {
  const caller = c.get("user")
  const { projectId, userId, pin, roleLevel, expiresAt: expiresAtInput } = c.req.valid("json")

  // Permission: same bar as minting a share-link invite.
  const resolved = await resolveProjectRole(c.env, caller, projectId)
  if (!resolved) {
    return c.json({ error: `project not found: ${projectId}` }, 404)
  }
  if (resolved.level < INVITE_MIN_ROLE) {
    return c.json({ error: "role >= project_lead required to mint an access link" }, 403)
  }

  // Target account must exist — this flow never creates users.
  const targetUser = await c.env.AQUILLA_PG.prepare(
    "SELECT id, username FROM users WHERE id = ?",
  )
    .bind(userId)
    .first<{ id: number; username: string }>()
  if (!targetUser) {
    return c.json({ error: "target user not found" }, 404)
  }

  const grantedRole = clampLinkRole(roleLevel ?? ROLE.CONTRIBUTOR)

  // Ensure the bound account can actually read/write the project on arrival:
  // upsert membership max-wins (never demote an existing higher grant).
  const existingMember = await c.env.AQUILLA_PG.prepare(
    "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, userId)
    .first<{ role_level: number }>()
  if (existingMember) {
    if (grantedRole > existingMember.role_level) {
      await c.env.AQUILLA_PG.prepare(
        `UPDATE project_members
            SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
          WHERE project_id = ? AND user_id = ?`,
      )
        .bind(grantedRole, caller.id, projectId, userId)
        .run()
    }
  } else {
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)`,
    )
      .bind(projectId, userId, grantedRole, caller.id)
      .run()
  }

  const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "")
  const pinHash = await hashPasswordWerkzeugScrypt(pin)
  const expiresAt = expiresAtInput ?? new Date(Date.now() + DEFAULT_LINK_TTL_MS).toISOString()

  try {
    await c.env.AQUILLA_PG.prepare(
      `INSERT INTO project_access_links
         (token, project_id, user_id, pin_hash, role_level, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(token, projectId, userId, pinHash, grantedRole, caller.id, expiresAt)
      .run()
  } catch (err) {
    console.error("[access-links] mint failed:", err)
    return c.json({ error: "Failed to create access link" }, 500)
  }

  return c.json({
    token,
    projectId,
    userId,
    role: grantedRole,
    expiresAt,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/access-links/:token/redeem — PUBLIC.
//
// Body: { pin }. On success mints a JWT for the bound account and returns it
// plus the target project so the fresh browser can land straight in. Every
// failure returns the same 401 DEAD_LINK body (no token/PIN oracle).
// ──────────────────────────────────────────────────────────────────────────

const redeemSchema = z.object({
  pin: z.string().min(1).max(64),
})

accessLinks.post("/:token/redeem", zValidator("json", redeemSchema), async (c) => {
  // Redemption is unauthenticated (the link + PIN IS the auth) and its 401 is
  // heuristically cacheable — never let a browser cache a dead-link verdict.
  c.header("Cache-Control", "no-store")

  if (!c.env.SECRET_KEY || !c.env.ALGORITHM) {
    return c.json({ error: "Authentication is not configured" }, 503)
  }

  const token = c.req.param("token")
  const { pin } = c.req.valid("json")

  const link = await c.env.AQUILLA_PG.prepare(
    `SELECT token, project_id, user_id, pin_hash, role_level, created_by,
            created_at, expires_at, revoked_at, failed_attempts, locked_until,
            last_used_at
       FROM project_access_links WHERE token = ?`,
  )
    .bind(token)
    .first<ProjectAccessLinkRow>()

  // Unknown / revoked / expired / locked all collapse to the same dead-link
  // response — no branch is observable to the caller.
  const now = new Date()
  if (!link) return c.json(DEAD_LINK, 401)
  if (link.revoked_at) return c.json(DEAD_LINK, 401)
  if (link.expires_at && new Date(link.expires_at) < now) return c.json(DEAD_LINK, 401)
  if (link.locked_until && new Date(link.locked_until) > now) return c.json(DEAD_LINK, 401)

  let pinOk = false
  try {
    pinOk = await verifyPasswordWerkzeugScrypt(pin, link.pin_hash)
  } catch (err) {
    // A corrupt stored hash is an ops problem, not a caller-visible one.
    console.error("[access-links] PIN verify failed:", err)
    pinOk = false
  }

  if (!pinOk) {
    const attempts = link.failed_attempts + 1
    const lockedUntil =
      attempts >= MAX_FAILED_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null
    try {
      await c.env.AQUILLA_PG.prepare(
        `UPDATE project_access_links
            SET failed_attempts = ?, locked_until = ?
          WHERE token = ?`,
      )
        .bind(attempts, lockedUntil, token)
        .run()
    } catch (err) {
      console.error("[access-links] attempt bump failed:", err)
    }
    return c.json(DEAD_LINK, 401)
  }

  // Success: clear the throttle, stamp last use, mint a session for the bound
  // account. The account's username is the JWT `sub`; the workspace's normal
  // sync-token path re-resolves its project role on arrival.
  const boundUser = await c.env.AQUILLA_PG.prepare(
    "SELECT username FROM users WHERE id = ?",
  )
    .bind(link.user_id)
    .first<{ username: string }>()
  if (!boundUser) {
    // Bound account was deleted after mint — the link is dead.
    return c.json(DEAD_LINK, 401)
  }

  try {
    await c.env.AQUILLA_PG.prepare(
      `UPDATE project_access_links
          SET failed_attempts = 0, locked_until = NULL, last_used_at = CURRENT_TIMESTAMP
        WHERE token = ?`,
    )
      .bind(token)
      .run()
  } catch (err) {
    console.error("[access-links] last-use stamp failed:", err)
  }

  const jwtService = new JWTService(c.env)
  const accessToken = await jwtService.createAccessToken(boundUser.username)
  return c.json({
    access_token: accessToken,
    token_type: "bearer",
    username: boundUser.username,
    project_id: link.project_id,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/access-links/:token/revoke — authed, project_lead+ on the
// link's project. Soft-kills a leaked link.
// ──────────────────────────────────────────────────────────────────────────

accessLinks.post("/:token/revoke", authMiddleware, async (c) => {
  const caller = c.get("user")
  const token = c.req.param("token")

  const link = await c.env.AQUILLA_PG.prepare(
    "SELECT project_id, revoked_at FROM project_access_links WHERE token = ?",
  )
    .bind(token)
    .first<{ project_id: string; revoked_at: string | null }>()
  if (!link) {
    return c.json({ error: "Access link not found" }, 404)
  }

  const resolved = await resolveProjectRole(c.env, caller, link.project_id)
  if (!resolved || resolved.level < INVITE_MIN_ROLE) {
    return c.json({ error: "role >= project_lead required to revoke an access link" }, 403)
  }

  if (!link.revoked_at) {
    await c.env.AQUILLA_PG.prepare(
      "UPDATE project_access_links SET revoked_at = CURRENT_TIMESTAMP WHERE token = ?",
    )
      .bind(token)
      .run()
  }

  return c.json({ token, revoked: true })
})

export default accessLinks
