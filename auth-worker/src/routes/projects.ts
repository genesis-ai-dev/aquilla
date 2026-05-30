// Projects routes — codex-web's authoritative project surface. Ported from
// frontier-server's `cloudflare/src/routes/projects.ts` (origin/main) but
// scoped to what codex-web actually uses: no `/progress/*`, no GitLab.
//
// Mounted at /api/v2/projects in src/index.ts. Routes:
//
//   POST   /                              create project (server-side row)
//   GET    /                              list caller's projects
//   GET    /:projectId                    project state + role + file list
//   POST   /:projectId/archive            move to Trash (owner-only)
//   DELETE /:projectId/archive            restore from Trash (owner-only)
//   GET    /:projectId/members            effective member list
//   POST   /:projectId/members            add member by username
//   DELETE /:projectId/members/:userId    remove direct member
//   DELETE /:projectId/files/:fileId      drop file projection (contributor+)
//   POST   /:projectId/invites            mint share-link invite
//   GET    /invite-preview/:token         JoinPage prefill (public)
//   POST   /accept-invite                 joiner redeems
//   DELETE /:projectId/invites/:token     revoke an unused invite
//
// All non-public routes apply `authMiddleware`. Routes that touch
// `c.env.AQUILLA_DB` no-op gracefully if the binding is absent (test envs).

import { Hono } from "hono"
import { zValidator } from "@hono/zod-validator"
import { z } from "zod"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import {
  INVITE_MIN_ROLE,
  LINK_ROLE_CAP,
  ROLE,
  type ProjectInviteRow,
  type ProjectRow,
} from "../types"
import {
  ALL_ROLE_LEVELS,
  isCanonicalRoleLevel,
  isLinkRoleLevel,
  LINK_ROLE_ALLOWED,
  resolveProjectRole,
  resolveProjectRoleIncludingArchived,
  ROLE_NAMES,
} from "../services/project-permissions"
import {
  bumpOrgActivity,
  getOrCreateUserOrg,
  listEffectiveProjectMembers,
} from "../services/org-permissions"
import { lookupUserByUsername } from "../services/user-lookup"

const projects = new Hono<AuthHonoEnv>()

// Default invite lifetime — 30 days. Mirrors the open-link UX of the old
// share-token flow and gives recipients time to redeem on a fresh laptop.
const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000

function roleNameFor(level: number): string {
  return ROLE_NAMES[level] ?? `level_${level}`
}

interface FileProjection {
  id: string
  name: string
  type: string
  cellCount: number
}

/**
 * Pull file projections for the given project ids from codex-db, grouped by
 * project_id. Returns an empty map if the binding is absent (tests/dev).
 */
async function loadFilesByProject(
  env: AuthHonoEnv["Bindings"],
  projectIds: string[],
): Promise<Map<string, FileProjection[]>> {
  const byProject = new Map<string, FileProjection[]>()
  if (!env.AQUILLA_DB || projectIds.length === 0) return byProject

  const placeholders = projectIds.map(() => "?").join(",")
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT id, project_id, name, kind, role, cell_count
       FROM files
      WHERE project_id IN (${placeholders})
      ORDER BY name COLLATE NOCASE`,
  )
    .bind(...projectIds)
    .all<{
      id: string
      project_id: string
      name: string
      kind: string | null
      role: string | null
      cell_count: number | null
    }>()

  for (const f of rows.results ?? []) {
    const list = byProject.get(f.project_id) ?? []
    list.push({
      id: f.id,
      name: f.name,
      // `file_type` collapsed into role + kind (0012); derive a compatible value.
      type: f.kind ?? f.role ?? "codex",
      cellCount: f.cell_count ?? 0,
    })
    byProject.set(f.project_id, list)
  }
  return byProject
}

/** Best-effort notify aquilla-sync-worker that a project was (un)archived. */
async function notifySyncWorkerOfArchive(
  env: AuthHonoEnv["Bindings"],
  projectId: string,
  archivedAt: string | null,
  deletedBy: string | null,
): Promise<void> {
  if (!env.SYNC_WORKER_URL || !env.SYNC_SECRET_KEY) return
  try {
    await fetch(
      `${env.SYNC_WORKER_URL.replace(/\/$/, "")}/admin/projects/${encodeURIComponent(projectId)}/archive`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SYNC_SECRET_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ archivedAt, deletedBy }),
      },
    )
  } catch (err) {
    console.warn(`sync-worker archive notification failed for ${projectId}:`, err)
  }
}

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/projects — create a server-side project row
// ──────────────────────────────────────────────────────────────────────────

const createProjectSchema = z.object({
  id: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
})

projects.post(
  "/",
  authMiddleware,
  zValidator("json", createProjectSchema),
  async (c) => {
    const user = c.get("user")
    const body = c.req.valid("json")

    let orgId: number | null = null
    try {
      orgId = (await getOrCreateUserOrg(c.env, user)).id
    } catch (err) {
      // Project ownership is still authoritative through `projects.created_by`.
      // If personal-org provisioning is unavailable because the deployed D1
      // schema is temporarily ahead/behind the worker, do not block the core
      // user journey of creating a project.
      console.warn("personal org setup failed; creating project without org:", err)
    }

    try {
      await c.env.AQUILLA_DB.prepare(
        `INSERT INTO projects (id, name, org_id, created_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
        .bind(body.id, body.name, orgId, user.id)
        .run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("project create failed:", err)
      return c.json({ error: `create failed: ${message}` }, 500)
    }

    return c.json({
      id: body.id,
      name: body.name,
      orgId,
      role: { level: 700, name: "owner", source: "creator" },
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects — list caller's accessible projects + files
// ──────────────────────────────────────────────────────────────────────────

projects.get("/", authMiddleware, async (c) => {
  const user = c.get("user")

  const orgIdParam = c.req.query("orgId")
  const orgFilter = orgIdParam != null && orgIdParam !== "" ? Number(orgIdParam) : null

  // AD-12 max-wins across direct + group + org + creator. Each path is
  // computed in the same query; role_level = MAX(coalesced levels). On a
  // tie, attribution credit goes in declaration order (override > group >
  // org > creator) to match the resolver in project-permissions.ts.
  //
  // Params (positional ?): 10 user.id binds + 2 orgFilter binds at the end.
  //   ?1-?4  : user.id for creator CASE expressions
  //   ?5-?7  : user.id for LEFT JOIN conditions (pm, om, gm)
  //   ?8-?10 : user.id for WHERE access check (created_by, pm, om)
  //   ?11    : orgFilter (NULL or number) — IS NULL check (no-filter case)
  //   ?12    : orgFilter (NULL or number) — equality check (filter case)
  const rows = await c.env.AQUILLA_DB.prepare(
    `SELECT p.id, p.name, p.org_id,
            MAX(
              COALESCE(pm.role_level, 0),
              COALESCE(gg.max_grant,  0),
              COALESCE(om.role_level, 0),
              CASE WHEN p.created_by = ? THEN 700 ELSE 0 END
            ) AS role_level,
            CASE
              WHEN pm.role_level IS NOT NULL
                AND pm.role_level >= COALESCE(gg.max_grant, 0)
                AND pm.role_level >= COALESCE(om.role_level, 0)
                AND pm.role_level >= (CASE WHEN p.created_by = ? THEN 700 ELSE 0 END)
              THEN 'override'
              WHEN gg.max_grant IS NOT NULL
                AND gg.max_grant >= COALESCE(om.role_level, 0)
                AND gg.max_grant >= (CASE WHEN p.created_by = ? THEN 700 ELSE 0 END)
              THEN 'group'
              WHEN om.role_level IS NOT NULL
                AND om.role_level >= (CASE WHEN p.created_by = ? THEN 700 ELSE 0 END)
              THEN 'org'
              ELSE 'creator'
            END AS role_source
       FROM projects p
       LEFT JOIN project_members pm
         ON pm.project_id = p.id AND pm.user_id = ?
       LEFT JOIN org_members om
         ON om.org_id = p.org_id AND om.user_id = ?
       LEFT JOIN (
         SELECT gpg.project_id, MAX(gpg.role_level) AS max_grant
           FROM group_project_grants gpg
           JOIN group_members gm
             ON gm.group_id = gpg.group_id
          WHERE gm.user_id = ?
          GROUP BY gpg.project_id
       ) gg
         ON gg.project_id = p.id
      WHERE p.archived_at IS NULL
        AND (
          p.created_by = ?
          OR pm.user_id = ?
          OR gg.max_grant IS NOT NULL
          OR (p.org_id IS NOT NULL AND om.user_id = ?)
        )
        AND (? IS NULL OR p.org_id = ?)
      ORDER BY p.name COLLATE NOCASE`,
  )
    .bind(
      user.id, user.id, user.id, user.id,  // ?1-?4: CASE-when-creator
      user.id, user.id, user.id,           // ?5-?7: pm.user_id, om.user_id, gm.user_id
      user.id, user.id, user.id,           // ?8-?10: WHERE: created_by, pm, om
      orgFilter, orgFilter,                // ?11-?12: org filter (IS NULL bypass + equality)
    )
    .all<{
      id: string
      name: string
      org_id: number | null
      role_level: number
      role_source: "creator" | "override" | "org" | "group"
    }>()

  const projectIds = (rows.results ?? []).map((r) => r.id)
  const filesByProject = await loadFilesByProject(c.env, projectIds)

  return c.json({
    projects: (rows.results ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      orgId: row.org_id,
      role: {
        level: row.role_level,
        name: roleNameFor(row.role_level),
        source: row.role_source,
      },
      files: filesByProject.get(row.id) ?? [],
    })),
  })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId — project state + role + files
// ──────────────────────────────────────────────────────────────────────────

projects.get("/:projectId", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)

  const row = await c.env.AQUILLA_DB.prepare(
    `SELECT p.id, p.name, p.archived_at, p.archived_by,
            u.username AS archived_by_username
       FROM projects p
       LEFT JOIN users u ON u.id = p.archived_by
      WHERE p.id = ?`,
  )
    .bind(projectId)
    .first<{
      id: string
      name: string
      archived_at: string | null
      archived_by: number | null
      archived_by_username: string | null
    }>()

  if (!row) return c.json({ error: "not found" }, 404)

  const filesByProject = await loadFilesByProject(c.env, [projectId])
  const files = filesByProject.get(projectId) ?? []

  return c.json({
    id: row.id,
    name: row.name,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by
      ? { id: row.archived_by, username: row.archived_by_username }
      : null,
    role: { level: role.level, name: role.name, source: role.source },
    files,
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/projects/:projectId/archive — owner-only
// ──────────────────────────────────────────────────────────────────────────

projects.post("/:projectId/archive", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < 700) {
    return c.json({ error: "only owners can archive a project" }, 403)
  }

  try {
    await c.env.AQUILLA_DB.prepare(
      `UPDATE projects
          SET archived_at = CURRENT_TIMESTAMP,
              archived_by = ?
        WHERE id = ? AND archived_at IS NULL`,
    )
      .bind(user.id, projectId)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("project archive failed:", err)
    return c.json({ error: `archive failed: ${message}` }, 500)
  }

  const row = await c.env.AQUILLA_DB.prepare(
    "SELECT archived_at, archived_by FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ archived_at: string | null; archived_by: number | null }>()

  c.executionCtx.waitUntil(
    notifySyncWorkerOfArchive(c.env, projectId, row?.archived_at ?? null, user.username),
  )

  return c.json({
    ok: true,
    archivedAt: row?.archived_at,
    archivedBy: { id: user.id, username: user.username },
  })
})

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/v2/projects/:projectId/archive — restore (owner-only)
// ──────────────────────────────────────────────────────────────────────────

projects.delete("/:projectId/archive", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRoleIncludingArchived(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < 700) {
    return c.json({ error: "only owners can restore a project" }, 403)
  }

  try {
    await c.env.AQUILLA_DB.prepare(
      `UPDATE projects
          SET archived_at = NULL,
              archived_by = NULL
        WHERE id = ?`,
    )
      .bind(projectId)
      .run()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("project restore failed:", err)
    return c.json({ error: `restore failed: ${message}` }, 500)
  }

  c.executionCtx.waitUntil(notifySyncWorkerOfArchive(c.env, projectId, null, null))

  return c.json({ ok: true })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId/members — effective member list
// ──────────────────────────────────────────────────────────────────────────

projects.get("/:projectId/members", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const project = await c.env.AQUILLA_DB.prepare(
    "SELECT created_by, org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ created_by: number; org_id: number | null }>()
  if (!project) return c.json({ error: "project not found" }, 404)

  const members = await listEffectiveProjectMembers(
    c.env,
    projectId,
    project.org_id,
    project.created_by,
  )

  await bumpOrgActivity(c.env, user.id, project.org_id)

  return c.json({
    members: members.map((m) => ({
      userId: m.userId,
      username: m.username,
      role: {
        level: m.roleLevel,
        name: roleNameFor(m.roleLevel),
        source: m.source,
      },
    })),
  })
})

// ──────────────────────────────────────────────────────────────────────────
// POST /api/v2/projects/:projectId/members — direct add by username
// ──────────────────────────────────────────────────────────────────────────

const projectMemberBody = z.object({
  username: z.string().min(1),
  role: z
    .number()
    .int()
    .refine(isCanonicalRoleLevel, {
      message: `role must be one of ${ALL_ROLE_LEVELS.join(", ")}`,
    }),
})

projects.post(
  "/:projectId/members",
  authMiddleware,
  zValidator("json", projectMemberBody),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const callerRole = await resolveProjectRole(c.env, user, projectId)
    if (!callerRole) return c.json({ error: "no access to project" }, 403)
    if (callerRole.level < 500) {
      return c.json({ error: "role >= project_lead required" }, 403)
    }

    const { username, role } = c.req.valid("json")
    if (role > callerRole.level) {
      return c.json(
        { error: `cannot grant role ${role} as ${callerRole.name} (${callerRole.level})` },
        403,
      )
    }

    const target = await lookupUserByUsername(c.env, username)
    if (!target) return c.json({ error: "user not found" }, 404)
    if (target.id === user.id) {
      return c.json({ error: "cannot grant role to self" }, 400)
    }

    await c.env.AQUILLA_DB.prepare(
      `INSERT INTO project_members (project_id, user_id, role_level, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET
         role_level = excluded.role_level,
         granted_by = excluded.granted_by,
         granted_at = CURRENT_TIMESTAMP`,
    )
      .bind(projectId, target.id, role, user.id)
      .run()

    return c.json({
      userId: target.id,
      username: target.username,
      role: { level: role, name: roleNameFor(role), source: "override" },
    })
  },
)

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/v2/projects/:projectId/members/:userId — maintainer+
// ──────────────────────────────────────────────────────────────────────────

projects.delete("/:projectId/members/:userId", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const targetUserId = parseInt(c.req.param("userId") as string, 10)
  if (!Number.isFinite(targetUserId)) {
    return c.json({ error: "invalid userId" }, 400)
  }

  const callerRole = await resolveProjectRole(c.env, user, projectId)
  if (!callerRole) return c.json({ error: "no access to project" }, 403)
  if (callerRole.level < 600) {
    return c.json({ error: "role >= maintainer required" }, 403)
  }

  const existing = await c.env.AQUILLA_DB.prepare(
    "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, targetUserId)
    .first<{ role_level: number }>()
  if (!existing) {
    return c.json(
      { error: "user has no direct project membership; remove from org instead" },
      409,
    )
  }

  await c.env.AQUILLA_DB.prepare(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, targetUserId)
    .run()

  return c.json({ removed: true })
})

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/v2/projects/:projectId/files/:fileId — drop projection
// ──────────────────────────────────────────────────────────────────────────

projects.delete("/:projectId/files/:fileId", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const fileId = c.req.param("fileId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < 400) {
    return c.json({ error: "not allowed" }, 403)
  }

  if (c.env.AQUILLA_DB) {
    try {
      await c.env.AQUILLA_DB.prepare(
        "DELETE FROM files WHERE id = ? AND project_id = ?",
      )
        .bind(fileId, projectId)
        .run()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error("delete file projection failed:", err)
      return c.json({ error: `delete failed: ${message}` }, 500)
    }
  }

  // Best-effort R2 cleanup via sync-worker's admin endpoint.
  if (c.env.SYNC_WORKER_URL && c.env.SYNC_SECRET_KEY) {
    try {
      const res = await fetch(
        `${c.env.SYNC_WORKER_URL.replace(/\/$/, "")}/admin/files/${encodeURIComponent(projectId)}/${encodeURIComponent(fileId)}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${c.env.SYNC_SECRET_KEY}` },
        },
      )
      if (!res.ok) {
        console.warn(
          `sync-worker R2 cleanup returned HTTP ${res.status} for ${projectId}/${fileId}`,
        )
      }
    } catch (err) {
      console.warn("sync-worker R2 cleanup failed:", err)
    }
  }

  return c.json({ ok: true })
})

// ──────────────────────────────────────────────────────────────────────────
// Invite endpoints (preserved from the old projects-invites.ts).
// ──────────────────────────────────────────────────────────────────────────

const createInviteSchema = z.object({
  role: z.number().int().min(100).max(700).optional(),
  email: z.string().email().optional(),
})

const acceptInviteSchema = z.object({
  token: z.string().min(8),
})

// POST /api/v2/projects/:projectId/invites — sharer side.
projects.post(
  "/:projectId/invites",
  authMiddleware,
  zValidator("json", createInviteSchema),
  async (c) => {
    const user = c.get("user")
    const projectId = c.req.param("projectId") as string
    const { role, email } = c.req.valid("json")

    const resolved = await resolveProjectRole(c.env, user, projectId)
    if (!resolved) {
      return c.json({ error: "Project not found" }, 404)
    }
    if (resolved.level < INVITE_MIN_ROLE) {
      return c.json(
        { error: "You don't have permission to share this project" },
        403,
      )
    }

    // Cap the granted role at contributor — managerial roles aren't grantable
    // via tokenized URLs. Default to contributor when role is omitted.
    let grantedRole = role ?? ROLE.CONTRIBUTOR
    if (grantedRole > LINK_ROLE_CAP) grantedRole = LINK_ROLE_CAP
    if (grantedRole < ROLE.VIEWER) grantedRole = ROLE.VIEWER
    if (!isLinkRoleLevel(grantedRole)) {
      // belt-and-suspenders: clamp to nearest allowed link role
      grantedRole = LINK_ROLE_CAP
    }

    const token = crypto.randomUUID().replace(/-/g, "")
    const expiresAt = new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString()

    try {
      await c.env.AQUILLA_DB.prepare(
        `INSERT INTO project_invites
           (token, project_id, role_level, created_by, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(token, projectId, grantedRole, user.id, expiresAt)
        .run()
    } catch (err) {
      console.error("[invites] create failed:", err)
      return c.json({ error: "Failed to create invite" }, 500)
    }

    return c.json({
      token,
      projectId,
      role: grantedRole,
      expiresAt,
      ...(email ? { email } : {}),
    })
  },
)

// GET /api/v2/projects/invite-preview/:token — public, no JWT required.
projects.get("/invite-preview/:token", async (c) => {
  const token = c.req.param("token") as string
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const invite = await c.env.AQUILLA_DB.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at
     FROM project_invites WHERE token = ?`,
  )
    .bind(token)
    .first<ProjectInviteRow>()

  if (!invite) {
    return c.json({ error: "Invite not found" }, 404)
  }
  if (invite.expires_at) {
    const expiresAt = new Date(invite.expires_at)
    if (expiresAt < new Date()) {
      return c.json({ error: "Invite expired" }, 410)
    }
  }
  if (invite.used_at) {
    return c.json({ error: "Invite already used" }, 410)
  }

  const project = await c.env.AQUILLA_DB.prepare(
    `SELECT id, name, org_id, created_by, archived_at
     FROM projects WHERE id = ?`,
  )
    .bind(invite.project_id)
    .first<ProjectRow>()
  if (!project) {
    return c.json({ error: "Project not found" }, 404)
  }
  if (project.archived_at) {
    return c.json({ error: "Project is archived" }, 410)
  }

  return c.json({
    projectId: invite.project_id,
    projectName: project.name,
    role: {
      level: invite.role_level,
      name: roleNameFor(invite.role_level),
    },
    expiresAt: invite.expires_at,
    email: null,
  })
})

// POST /api/v2/projects/accept-invite — joiner side.
projects.post(
  "/accept-invite",
  authMiddleware,
  zValidator("json", acceptInviteSchema),
  async (c) => {
    const user = c.get("user")
    const { token } = c.req.valid("json")

    const invite = await c.env.AQUILLA_DB.prepare(
      `SELECT token, project_id, role_level, created_by, created_at,
              expires_at, used_by, used_at
       FROM project_invites WHERE token = ?`,
    )
      .bind(token)
      .first<ProjectInviteRow>()
    if (!invite) {
      return c.json({ error: "Invite not found" }, 404)
    }
    if (invite.expires_at) {
      const expiresAt = new Date(invite.expires_at)
      if (expiresAt < new Date()) {
        return c.json({ error: "Invite expired" }, 410)
      }
    }
    if (invite.used_at && invite.used_by !== user.id) {
      return c.json({ error: "Invite already used" }, 410)
    }

    const existing = await c.env.AQUILLA_DB.prepare(
      `SELECT role_level FROM project_members
       WHERE project_id = ? AND user_id = ?`,
    )
      .bind(invite.project_id, user.id)
      .first<{ role_level: number }>()

    const finalRole = existing
      ? Math.max(existing.role_level, invite.role_level)
      : invite.role_level

    try {
      if (existing) {
        await c.env.AQUILLA_DB.prepare(
          `UPDATE project_members
           SET role_level = ?, granted_by = ?, granted_at = CURRENT_TIMESTAMP
           WHERE project_id = ? AND user_id = ?`,
        )
          .bind(finalRole, invite.created_by, invite.project_id, user.id)
          .run()
      } else {
        await c.env.AQUILLA_DB.prepare(
          `INSERT INTO project_members
             (project_id, user_id, role_level, granted_by)
           VALUES (?, ?, ?, ?)`,
        )
          .bind(invite.project_id, user.id, finalRole, invite.created_by)
          .run()
      }
      if (!invite.used_at) {
        await c.env.AQUILLA_DB.prepare(
          `UPDATE project_invites
           SET used_by = ?, used_at = CURRENT_TIMESTAMP
           WHERE token = ?`,
        )
          .bind(user.id, token)
          .run()
      }
    } catch (err) {
      console.error("[invites] accept failed:", err)
      return c.json({ error: "Failed to accept invite" }, 500)
    }

    return c.json({ projectId: invite.project_id, role: finalRole })
  },
)

// DELETE /api/v2/projects/:projectId/invites/:token — revoke an unused invite.
projects.delete("/:projectId/invites/:token", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const token = c.req.param("token") as string

  const callerRole = await resolveProjectRole(c.env, user, projectId)
  if (!callerRole || callerRole.level < INVITE_MIN_ROLE) {
    return c.json({ error: "role >= project_lead required" }, 403)
  }

  const result = await c.env.AQUILLA_DB.prepare(
    `DELETE FROM project_invites
      WHERE token = ? AND project_id = ? AND used_by IS NULL`,
  )
    .bind(token, projectId)
    .run()

  const changes = result.meta?.changes
  const removed = typeof changes === "number" ? changes > 0 : true
  return c.json({ removed })
})

// Re-export the canonical link-role list so tests that imported it from the
// old projects-invites module continue to work.
export { LINK_ROLE_ALLOWED }

export default projects
