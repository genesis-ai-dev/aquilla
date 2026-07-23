// Multi-project invite routes (Aquilla spec 03-data-model.md §"Project
// invite": "Invite belongs to one Project (single-project invite) or many
// Projects (multi-project invite — multiple project_invites rows share a
// token in the prototype)").
//
// Mounted at /api/v2/invites in src/index.ts. The legacy single-project
// invite endpoints (POST /api/v2/projects/:id/invites,
// POST /api/v2/projects/accept-invite, GET /invite-preview/:token,
// DELETE /:id/invites/:token) continue to live in routes/projects.ts and
// keep working unchanged. This file adds:
//
//   POST /api/v2/invites/multi              mint one token spanning N projects
//   POST /api/v2/invites/:token/accept      redeem (materializes a project_members
//                                            row per row sharing the token)
//   GET  /api/v2/invites/:token/preview     joiner-side prefill (public)
//
// The multi-token surface uses the `(token, project_id)` composite PK from
// migration 0006_multi_project_invites.sql. Per spec, redemption stamps
// `used_by`/`used_at` on every row sharing the token.

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { JWTService } from "../auth/jwt"
import type { AuthUser, Env } from "../types"
import {
  INVITE_MIN_ROLE,
  LINK_ROLE_CAP,
  ROLE,
  type ProjectInviteRow,
  type ProjectRow,
} from "../types"
import {
  isLinkRoleLevel,
  resolveProjectRole,
  ROLE_NAMES,
} from "../services/project-permissions"
import {
  applyInviteLaneScopes,
  MAX_INVITE_SCOPE_LANES,
  MAX_LANE_VALUE_LENGTH,
  parseScopeLanes,
  serializeScopeLanes,
} from "../services/invite-scopes"

const invites = new Hono<AuthHonoEnv>()

/**
 * AQU-347: best-effort caller identity for the (otherwise public) preview
 * route. Unlike `authMiddleware`, a missing/invalid/expired token is NOT an
 * error here — it just means "treat this preview as anonymous", since the
 * route must stay reachable for signed-out visitors following a share link.
 */
async function optionalCaller(env: Env, authHeader: string | null): Promise<AuthUser | null> {
  if (!authHeader) return null
  const jwtService = new JWTService(env)
  const token = jwtService.extractTokenFromHeader(authHeader)
  if (!token) return null
  const payload = await jwtService.verifyToken(token)
  if (!payload) return null
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp < now) return null
  return jwtService.getUserByUsername(payload.sub)
}

// 30-day default lifetime, matching the single-project invite flow in
// routes/projects.ts.
const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function roleNameFor(level: number): string {
  return ROLE_NAMES[level] ?? `level_${level}`
}

function clampLinkRole(level: number): number {
  let n = level
  if (n > LINK_ROLE_CAP) n = LINK_ROLE_CAP
  if (n < ROLE.VIEWER) n = ROLE.VIEWER
  if (!isLinkRoleLevel(n)) n = LINK_ROLE_CAP
  return n
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/invites/multi
//
// Body: { projectIds: string[], roleLevel?: number, expiresAt?: string }
//
// Mints one token; inserts one row per project (sharing the token + role
// + expiry). Caller must hold project_lead+ on every project in the list
// — partial success is not allowed.
// ──────────────────────────────────────────────────────────────────────────

const createMultiInviteSchema = z.object({
  projectIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  roleLevel: z.number().int().min(100).max(700).optional(),
  expiresAt: z.string().datetime().optional(),
  /**
   * AQU-528: optional lane (target-language) scopes auto-granted on join. The
   * same lane set applies to every project sharing the token. Omitted/empty =
   * unscoped invite (today's behavior).
   */
  scopeLanes: z
    .array(z.string().max(MAX_LANE_VALUE_LENGTH))
    .max(MAX_INVITE_SCOPE_LANES)
    .optional(),
})

invites.post(
  "/multi",
  authMiddleware,
  zValidator("json", createMultiInviteSchema),
  async (c) => {
    const user = c.get("user")
    const body = c.req.valid("json")

    // De-dupe before any DB work — clients sometimes accidentally
    // include the same id twice.
    const projectIds = Array.from(new Set(body.projectIds))

    const grantedRole = clampLinkRole(body.roleLevel ?? ROLE.CONTRIBUTOR)

    // Permission check on every project. Bail at the first denial so the
    // caller can't probe project ids by token.
    for (const pid of projectIds) {
      const resolved = await resolveProjectRole(c.env, user, pid)
      if (!resolved) {
        return c.json({ error: `project not found: ${pid}` }, 404)
      }
      if (resolved.level < INVITE_MIN_ROLE) {
        return c.json(
          {
            error: `role >= project_lead required (project ${pid})`,
          },
          403,
        )
      }
    }

    const token = crypto.randomUUID().replace(/-/g, "")
    const expiresAt =
      body.expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString()

    // AQU-528: same lane scopes on every row sharing the token; null = unscoped.
    const scopeLanesJson = serializeScopeLanes(body.scopeLanes)

    for (const pid of projectIds) {
      try {
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO project_invites
             (token, project_id, role_level, created_by, expires_at, scope_lanes)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
          .bind(token, pid, grantedRole, user.id, expiresAt, scopeLanesJson)
          .run()
      } catch (err) {
        console.error(`[invites/multi] insert failed for ${pid}:`, err)
        return c.json({ error: "Failed to create multi-project invite" }, 500)
      }
    }

    return c.json({
      token,
      projectIds,
      role: grantedRole,
      expiresAt,
      ...(scopeLanesJson ? { scopeLanes: parseScopeLanes(scopeLanesJson) } : {}),
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/invites/mine — pending invites addressed to the caller
// (AQU-326). Email-targeted invites only: open links carry no recipient
// identity and stay out-of-band by design. Privacy per AQU-321 — a user
// sees only invites whose email matches their own account email. Rows
// sharing a token (multi-project invites) are grouped into one entry.
//
// Registered before /:token/preview so "mine" is never parsed as a token.
// ──────────────────────────────────────────────────────────────────────────

invites.get("/mine", authMiddleware, async (c) => {
  const user = c.get("user")

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT pi.token AS token,
            pi.project_id AS project_id,
            p.name AS project_name,
            pi.role_level AS role_level,
            cu.username AS created_by_username,
            pi.created_at AS created_at,
            pi.expires_at AS expires_at
       FROM project_invites pi
       JOIN projects p ON p.id = pi.project_id
       JOIN users cu ON cu.id = pi.created_by
      WHERE LOWER(pi.email) = LOWER(?)
        AND pi.used_by IS NULL
        AND (pi.expires_at IS NULL OR pi.expires_at > CURRENT_TIMESTAMP)
        AND p.archived_at IS NULL
      ORDER BY pi.created_at DESC`,
  )
    .bind(user.email)
    .all<{
      token: string
      project_id: string
      project_name: string
      role_level: number
      created_by_username: string
      created_at: string
      expires_at: string | null
    }>()

  const byToken = new Map<
    string,
    {
      token: string
      role: { level: number; name: string }
      createdBy: string
      createdAt: string
      expiresAt: string | null
      projects: Array<{ projectId: string; projectName: string }>
    }
  >()
  for (const r of rows.results ?? []) {
    let entry = byToken.get(r.token)
    if (!entry) {
      entry = {
        token: r.token,
        role: { level: r.role_level, name: roleNameFor(r.role_level) },
        createdBy: r.created_by_username,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        projects: [],
      }
      byToken.set(r.token, entry)
    }
    entry.projects.push({ projectId: r.project_id, projectName: r.project_name })
  }

  return c.json({ invites: Array.from(byToken.values()) })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/invites/:token/preview — public; returns the list of project
// names + the shared role so the JoinPage can render a confirmation card
// before the user accepts.
// ──────────────────────────────────────────────────────────────────────────

invites.get("/:token/preview", async (c) => {
  // Preview responses vary by caller identity (AQU-347 usedByCaller) and 410s
  // are heuristically cacheable — a browser-cached anonymous 410 would mask
  // the authed 200 on the very next render. Never cache.
  c.header("Cache-Control", "no-store")
  const token = c.req.param("token") as string
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at, scope_lanes
       FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .all<ProjectInviteRow>()

  const invitesForToken = rows.results ?? []
  if (invitesForToken.length === 0) {
    return c.json({ error: "Invite not found" }, 404)
  }

  // Expiry / used checks: the shared rows all carry the same expires_at
  // (one writer minted them together). We sample the first.
  const first = invitesForToken[0]
  if (first.expires_at) {
    const expiresAt = new Date(first.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired", code: "time_expired" }, 410)
    }
  }
  // For multi-invites we DO allow re-preview if some rows are unused.
  const allUsed = invitesForToken.every((r) => r.used_at != null)

  // AQU-347: a used link isn't necessarily dead for THIS caller. If the
  // authenticated caller is the original redeemer (used_by === caller.id) on
  // a row AND is still a member of that row's project, re-clicking the link
  // should read as "you're already in — continue", not a terminal error.
  // Only rows the caller redeemed themself qualify — a used-by-someone-else
  // row never grants this caller a preview. `usedByCaller` distinguishes the
  // two below: a genuinely fresh row (used_at null) vs. one this caller is
  // just being let back into.
  const caller = allUsed ? await optionalCaller(c.env, c.req.header("Authorization") ?? null) : null
  let callerStillMemberOfAny = false
  const callerMembership = new Map<string, boolean>() // project_id -> still a member
  if (allUsed && caller) {
    const ownRows = invitesForToken.filter((r) => r.used_by === caller.id)
    if (ownRows.length > 0) {
      const placeholders = ownRows.map(() => "?").join(",")
      const memberRows = await c.env.AQUILLA_PG.prepare(
        `SELECT project_id FROM project_members
          WHERE user_id = ? AND project_id IN (${placeholders})`,
      )
        .bind(caller.id, ...ownRows.map((r) => r.project_id))
        .all<{ project_id: string }>()
      const stillMemberIds = new Set((memberRows.results ?? []).map((r) => r.project_id))
      for (const r of ownRows) {
        const stillMember = stillMemberIds.has(r.project_id)
        callerMembership.set(r.project_id, stillMember)
        if (stillMember) callerStillMemberOfAny = true
      }
    }
  }

  if (allUsed && !callerStillMemberOfAny) {
    return c.json({ error: "Invite already used", code: "used" }, 410)
  }

  // Pull project rows in one shot (org name included so the JoinPage can say
  // which workspace the invite belongs to — AQU-471).
  const placeholders = invitesForToken.map(() => "?").join(",")
  const projectRows = await c.env.AQUILLA_PG.prepare(
    `SELECT p.id, p.name, p.org_id, p.created_by, p.archived_at,
            o.name AS org_name
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.org_id
      WHERE p.id IN (${placeholders})`,
  )
    .bind(...invitesForToken.map((r) => r.project_id))
    .all<ProjectRow & { org_name: string | null }>()

  const byId = new Map<string, ProjectRow & { org_name: string | null }>()
  for (const p of projectRows.results ?? []) byId.set(p.id, p)

  // When re-previewing a used-but-still-a-member link, only surface the rows
  // the caller can actually continue into (their own, still-member rows) —
  // a multi-project token's other rows may belong to different redeemers.
  const rowsToShow = allUsed
    ? invitesForToken.filter((r) => callerMembership.get(r.project_id) === true)
    : invitesForToken

  const projects = rowsToShow
    .map((r) => {
      const p = byId.get(r.project_id)
      if (!p) return null
      return {
        projectId: r.project_id,
        projectName: p.name,
        orgName: p.org_name ?? null,
        archived: p.archived_at != null,
        usedByCaller: callerMembership.get(r.project_id) === true,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x != null)

  // All rows of a multi-invite are minted together by one inviter; sample the
  // first (AQU-471: "who invited me").
  const inviter = await c.env.AQUILLA_PG.prepare(
    "SELECT COALESCE(display_name, username) AS name FROM users WHERE id = ?",
  )
    .bind(first.created_by)
    .first<{ name: string | null }>()

  return c.json({
    token,
    role: { level: first.role_level, name: roleNameFor(first.role_level) },
    expiresAt: first.expires_at,
    invitedBy: inviter?.name ?? null,
    // AQU-528: lane scopes are shared across the token's rows (minted together);
    // empty = unscoped invite.
    scopeLanes: parseScopeLanes(first.scope_lanes),
    projects,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/invites/:token/accept
//
// Materializes a project_members row for EVERY project sharing the token.
// Stamps used_by / used_at on every row. If the caller is already a
// member of any project with a higher role, that row's role is preserved
// (never demote on accept).
// ──────────────────────────────────────────────────────────────────────────

invites.post("/:token/accept", authMiddleware, async (c) => {
  const user = c.get("user")
  const token = c.req.param("token") as string

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at, email, scope_lanes
       FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .all<ProjectInviteRow>()

  const invitesForToken = rows.results ?? []
  if (invitesForToken.length === 0) {
    return c.json({ error: "Invite not found" }, 404)
  }

  // Expiry check (sampled from first row; they all share expires_at).
  const first = invitesForToken[0]
  if (first.expires_at) {
    const expiresAt = new Date(first.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired", code: "time_expired" }, 410)
    }
  }

  // Email-bound invites: require the redeemer's account email to match
  // (case-insensitive), mirroring the legacy single-project accept (AQU-283).
  // JoinPage prefers THIS endpoint even for single-project tokens, so the
  // check must live here too or the binding is a dead letter (AQU-326).
  // All rows share the token's email; sample the first.
  if (first.email && first.email.toLowerCase() !== user.email.toLowerCase()) {
    return c.json(
      { error: "This invite was sent to a different email address." },
      403,
    )
  }

  // Archived projects can't be joined via invite (mirrors legacy accept).
  const archivedRows = await c.env.AQUILLA_PG.prepare(
    `SELECT id FROM projects
      WHERE id IN (${invitesForToken.map(() => "?").join(",")})
        AND archived_at IS NOT NULL`,
  )
    .bind(...invitesForToken.map((r) => r.project_id))
    .all<{ id: string }>()
  const archivedIds = new Set((archivedRows.results ?? []).map((r) => r.id))

  const accepted: Array<{ projectId: string; role: number }> = []

  for (const invite of invitesForToken) {
    if (archivedIds.has(invite.project_id)) {
      continue
    }
    // Row already stamped by a *different* user — a second person with the
    // same single-use link. Skip rather than 410-ing the whole multi-accept
    // so any remaining unused rows still flow.
    if (invite.used_at && invite.used_by !== user.id) {
      continue
    }

    try {
      // For a fresh (unused) row: atomically claim it with AND used_at IS NULL
      // BEFORE granting membership. This is the compare-and-swap that prevents
      // two concurrent users both getting admitted on a single-use link (RACE-7):
      // exactly one concurrent UPDATE will touch a row; the other sees 0 changes
      // and is rejected here, before the project_members write.
      //
      // For a same-user re-accept (invite.used_at already set, used_by === user.id):
      // skip the stamp block and fall through to the idempotent membership upsert.
      if (!invite.used_at) {
        const stampResult = await c.env.AQUILLA_PG.prepare(
          `UPDATE project_invites
              SET used_by = ?, used_at = CURRENT_TIMESTAMP
            WHERE token = ? AND project_id = ? AND used_at IS NULL`,
        )
          .bind(user.id, token, invite.project_id)
          .run()
        // Another concurrent request won the race on this row — skip it.
        if (stampResult.meta.changes === 0) {
          continue
        }
      }

      // Stamp succeeded (or same-user re-accept). Now grant/refresh membership.
      const existing = await c.env.AQUILLA_PG.prepare(
        `SELECT role_level FROM project_members
          WHERE project_id = ? AND user_id = ?`,
      )
        .bind(invite.project_id, user.id)
        .first<{ role_level: number }>()

      // AQU-347: "idempotent-while-member" (option 2). A same-user re-accept
      // (invite.used_at already set to this user) used to unconditionally
      // re-grant membership — including after the owner removed them from
      // this project, turning the old link into a permanent self-service
      // re-entry pass. Re-redemption by the SAME user is only a no-op
      // success while they're STILL a member of this project; once removed,
      // skip this row (same as a different user hitting an already-used
      // link) rather than re-inserting membership.
      if (invite.used_at && invite.used_by === user.id && !existing) {
        continue
      }

      const finalRole = existing
        ? Math.max(existing.role_level, invite.role_level)
        : invite.role_level

      if (existing) {
        await c.env.AQUILLA_PG.prepare(
          `UPDATE project_members
              SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
            WHERE project_id = ? AND user_id = ?`,
        )
          .bind(finalRole, invite.created_by, invite.project_id, user.id)
          .run()
      } else {
        await c.env.AQUILLA_PG.prepare(
          `INSERT INTO project_members
             (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(invite.project_id, user.id, finalRole, invite.created_by)
          .run()
        // AQU-528: auto-grant the invite's lane scope(s) to the NEW member on
        // join. Only for a fresh membership — never narrow an existing member.
        await applyInviteLaneScopes(
          c.env,
          invite.project_id,
          user.id,
          parseScopeLanes(invite.scope_lanes),
          invite.created_by,
          finalRole,
        )
      }

      accepted.push({ projectId: invite.project_id, role: finalRole })
    } catch (err) {
      console.error(
        `[invites/multi] accept failed for ${invite.project_id}:`,
        err,
      )
      return c.json({ error: "Failed to accept invite" }, 500)
    }
  }

  if (accepted.length === 0) {
    // Honest failure reason: every row pointing at an archived project is
    // a different situation than a spent single-use link.
    if (invitesForToken.every((r) => archivedIds.has(r.project_id))) {
      return c.json({ error: "This project has been archived." }, 410)
    }
    return c.json({ error: "Invite already used", code: "used" }, 410)
  }

  return c.json({ token, accepted })
})

export default invites
