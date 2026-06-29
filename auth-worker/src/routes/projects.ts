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
//   GET    /:projectId/invites            list active (unused+unexpired) invites
//   GET    /invite-preview/:token         JoinPage prefill (public)
//   POST   /accept-invite                 joiner redeems
//   DELETE /:projectId/invites/:token     revoke an unused invite
//
// All non-public routes apply `authMiddleware`. Routes that touch
// `c.env.AQUILLA_PG` no-op gracefully if the binding is absent (test envs).

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
import { getFileChapters, getMyAssignments, getProjectAssignmentRoster } from "../services/assignments"
import {
  bumpOrgActivity,
  getEffectiveOrgRole,
  getOrCreateUserOrg,
  listEffectiveProjectMembers,
} from "../services/org-permissions"
import { isPlatformAdminUsername } from "../middleware/platform-admin"
import { lookupUserByUsername } from "../services/user-lookup"
import { sendProjectInviteEmail } from "../services/email"

const projects = new Hono<AuthHonoEnv>()

function roleNameFor(level: number): string {
  return ROLE_NAMES[level] ?? `level_${level}`
}

interface FileProjection {
  id: string
  name: string
  type: string
  cellCount: number
  /** Timeline-segment-model order lens, read from files.meta. Omitted when
   *  unset → client treats as 'sequence'. */
  orderedBy?: string
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
  if (!env.AQUILLA_PG || projectIds.length === 0) return byProject

  const placeholders = projectIds.map(() => "?").join(",")
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT id, project_id, name, kind, role, cell_count, meta
       FROM files
      WHERE project_id IN (${placeholders})
      ORDER BY LOWER(name)`,
  )
    .bind(...projectIds)
    .all<{
      id: string
      project_id: string
      name: string
      kind: string | null
      role: string | null
      cell_count: number | null
      meta: string | null
    }>()

  for (const f of rows.results ?? []) {
    const list = byProject.get(f.project_id) ?? []
    // Timeline-segment-model: order lens lives in meta (JSON), same as langs.
    let orderedBy: string | undefined
    if (f.meta) {
      try {
        const m = JSON.parse(f.meta) as { orderedBy?: string }
        if (m.orderedBy) orderedBy = m.orderedBy
      } catch {
        // malformed meta → leave orderedBy unset (client defaults to sequence)
      }
    }
    list.push({
      id: f.id,
      name: f.name,
      // `file_type` collapsed into role + kind (0012); derive a compatible value.
      type: f.kind ?? f.role ?? "codex",
      cellCount: f.cell_count ?? 0,
      ...(orderedBy ? { orderedBy } : {}),
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
  orgId: z.number().int().optional(),
})

projects.post(
  "/",
  authMiddleware,
  zValidator("json", createProjectSchema),
  async (c) => {
    const user = c.get("user")
    const body = c.req.valid("json")

    let orgId: number | null = null
    if (body.orgId != null) {
      // Creating into a specific org is an org-level function: require the
      // caller's org role >= maintainer (see spec Risk 3).
      const orgRole = await getEffectiveOrgRole(c.env, body.orgId, user)
      if (orgRole == null || orgRole < ROLE.MAINTAINER) {
        return c.json({ error: "org role >= maintainer required to create a project here" }, 403)
      }
      orgId = body.orgId
    } else {
      try {
        orgId = (await getOrCreateUserOrg(c.env, user)).id
      } catch (err) {
        console.warn("personal org setup failed; creating project without org:", err)
      }
    }

    try {
      await c.env.AQUILLA_PG.prepare(
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

  if (orgFilter !== null && !Number.isInteger(orgFilter)) {
    return c.json({ error: "invalid orgId" }, 400)
  }

  const archivedParam = c.req.query("archived")
  const wantArchived = archivedParam === "true" || archivedParam === "1"
  const archivedClause = wantArchived ? "p.archived_at IS NOT NULL" : "p.archived_at IS NULL"

  // FRO-321: minRole filter — callers can pass ?minRole=600 to see only
  // projects where their resolved role >= the threshold (e.g. maintainer for
  // the invite picker). Ignored when isAdmin (admins resolve as 700 everywhere).
  const minRoleParam = c.req.query("minRole")
  const minRole = minRoleParam != null && minRoleParam !== "" ? Number(minRoleParam) : null
  if (minRole !== null && (!Number.isFinite(minRole) || minRole < 100 || minRole > 700)) {
    return c.json({ error: "invalid minRole" }, 400)
  }

  // Platform operators see every project (the WHERE access predicate is
  // bypassed below); their effective role is forced to 700/"platform" in the
  // JS mapping, mirroring the resolver in project-permissions.ts.
  const isAdmin = isPlatformAdminUsername(c.env, user.username)

  // AD-12 max-wins across direct + group + org + creator. Each path is
  // computed in the same query; role_level = MAX(coalesced levels). On a
  // tie, attribution credit goes in declaration order (override > group >
  // org > creator) to match the resolver in project-permissions.ts.
  //
  // Params (positional ?): 10 user.id binds + isAdmin + 2 orgFilter binds.
  //   ?1-?4  : user.id for creator CASE expressions
  //   ?5-?7  : user.id for LEFT JOIN conditions (pm, om, gm)
  //   ?8     : isAdmin (1/0) — platform operators bypass the access check
  //   ?9-?11 : user.id for WHERE access check (created_by, pm, om)
  //   ?12    : orgFilter (NULL or number) — IS NULL check (no-filter case)
  //   ?13    : orgFilter (NULL or number) — equality check (filter case)
  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT p.id, p.name, p.org_id, p.archived_at, p.is_active,
            GREATEST(
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
      WHERE ${archivedClause}
        AND (
          ?::int = 1
          OR p.created_by = ?
          OR pm.user_id = ?
          OR gg.max_grant IS NOT NULL
          OR (p.org_id IS NOT NULL AND om.user_id = ?)
        )
        AND (?::bigint IS NULL OR p.org_id = ?::bigint)
      ORDER BY LOWER(p.name)`,
  )
    .bind(
      user.id, user.id, user.id, user.id,  // ?1-?4: CASE-when-creator
      user.id, user.id, user.id,           // ?5-?7: pm.user_id, om.user_id, gm.user_id
      isAdmin ? 1 : 0,                     // ?8: platform-operator bypass
      user.id, user.id, user.id,           // ?9-?11: WHERE: created_by, pm, om
      orgFilter, orgFilter,                // ?12-?13: org filter (IS NULL bypass + equality)
    )
    .all<{
      id: string
      name: string
      org_id: number | null
      archived_at: string | null
      is_active: boolean
      role_level: number
      role_source: "creator" | "override" | "org" | "group"
    }>()

  // FRO-321: apply minRole filter before loading files (avoid extra DB round-trip).
  const allRows = rows.results ?? []
  const filteredRows = minRole !== null && !isAdmin
    ? allRows.filter((r) => r.role_level >= minRole)
    : allRows

  const projectIds = filteredRows.map((r) => r.id)
  const filesByProject = await loadFilesByProject(c.env, projectIds)

  return c.json({
    projects: filteredRows.map((row) => {
      // Platform operators resolve as owner everywhere (resolveProjectRole's
      // "platform" path); a genuine 700-level grant keeps its attribution.
      const role =
        isAdmin && row.role_level < 700
          ? { level: 700, name: roleNameFor(700), source: "platform" as const }
          : {
              level: row.role_level,
              name: roleNameFor(row.role_level),
              source: row.role_source,
            }
      return {
        id: row.id,
        name: row.name,
        orgId: row.org_id,
        archivedAt: row.archived_at,
        isActive: row.is_active,
        role,
        files: filesByProject.get(row.id) ?? [],
      }
    }),
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

  const row = await c.env.AQUILLA_PG.prepare(
    `SELECT p.id, p.name, p.org_id, p.archived_at, p.archived_by, p.is_active,
            u.username AS archived_by_username
       FROM projects p
       LEFT JOIN users u ON u.id = p.archived_by
      WHERE p.id = ?`,
  )
    .bind(projectId)
    .first<{
      id: string
      name: string
      org_id: number | null
      archived_at: string | null
      archived_by: number | null
      archived_by_username: string | null
      is_active: boolean
    }>()

  if (!row) return c.json({ error: "not found" }, 404)

  const filesByProject = await loadFilesByProject(c.env, [projectId])
  const files = filesByProject.get(projectId) ?? []

  return c.json({
    id: row.id,
    name: row.name,
    orgId: row.org_id,
    archivedAt: row.archived_at,
    archivedBy: row.archived_by
      ? { id: row.archived_by, username: row.archived_by_username }
      : null,
    isActive: row.is_active,
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
    await c.env.AQUILLA_PG.prepare(
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

  const row = await c.env.AQUILLA_PG.prepare(
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
    await c.env.AQUILLA_PG.prepare(
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
// PATCH /api/v2/projects/:projectId/lifecycle — toggle active/inactive
//   Role gate: project_lead+ (level >= 500), matching invite-creation gate.
//   Body: { isActive: boolean }
//   Response: { ok: true, isActive: boolean }
// ──────────────────────────────────────────────────────────────────────────

const lifecycleBody = z.object({ isActive: z.boolean() })
projects.patch("/:projectId/lifecycle", authMiddleware, zValidator("json", lifecycleBody), async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < 500) return c.json({ error: "project_lead+ required to change lifecycle" }, 403)
  const { isActive } = c.req.valid("json")
  await c.env.AQUILLA_PG.prepare(
    "UPDATE projects SET is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(isActive, projectId)
    .run()
  return c.json({ ok: true, isActive })
})

// ──────────────────────────────────────────────────────────────────────────
// PATCH /api/v2/projects/:projectId/deadline — set/clear deadline (maintainer+)
// ──────────────────────────────────────────────────────────────────────────

const deadlineBody = z.object({ deadline: z.string().min(1).max(40).nullable() })
projects.patch("/:projectId/deadline", authMiddleware, zValidator("json", deadlineBody), async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "not found or no access" }, 403)
  if (role.level < ROLE.MAINTAINER) return c.json({ error: "maintainer+ required" }, 403)
  const { deadline } = c.req.valid("json")
  await c.env.AQUILLA_PG.prepare(
    "UPDATE projects SET deadline_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(deadline, projectId)
    .run()
  return c.json({ ok: true, deadlineAt: deadline })
})

// ──────────────────────────────────────────────────────────────────────────
// GET /api/v2/projects/:projectId/members — effective member list
// ──────────────────────────────────────────────────────────────────────────

/**
 * GET /api/v2/projects/:projectId/assignments/mine — the caller's open
 * assignments in this project (the "Assigned to me" inbox). Any project member.
 */
projects.get("/:projectId/assignments/mine", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  const assignments = await getMyAssignments(c.env, projectId, user.id)
  return c.json({ assignments })
})

/**
 * GET /api/v2/projects/:projectId/assignments/all — per-assignee open workload
 * + derived progress for THIS project. Maintainer+ on the project required.
 * Returns the same AssigneeWorkload shape as the org workload endpoint so
 * the client can reuse the same rendering logic.
 */
projects.get("/:projectId/assignments/all", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  if (role.level < ROLE.MAINTAINER) return c.json({ error: "maintainer+ required" }, 403)
  const roster = await getProjectAssignmentRoster(c.env, projectId)
  return c.json({ roster })
})

/**
 * GET /api/v2/projects/:projectId/files/:fileId/chapters — distinct chapters
 * present in a file (for the assign picker's chapter dropdown). Any member.
 */
projects.get("/:projectId/files/:fileId/chapters", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const fileId = c.req.param("fileId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)
  const chapters = await getFileChapters(c.env, projectId, fileId)
  return c.json({ chapters })
})

projects.get("/:projectId/members", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role) return c.json({ error: "no access to project" }, 403)

  const project = await c.env.AQUILLA_PG.prepare(
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
      secondarySources: m.secondarySources,
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
    // Caller cannot grant a role higher than their own level.
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

    // FRO-285 (F-B6): target-level cap — you cannot add-over (change the role
    // of) a member whose current level is >= yours, unless you are owner (700).
    // Owners may modify any member. For a new member (no existing row), this
    // check is a no-op (existing.role_level will be 0).
    if (callerRole.level < ROLE.OWNER) {
      const existing = await c.env.AQUILLA_PG.prepare(
        "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
      )
        .bind(projectId, target.id)
        .first<{ role_level: number }>()
      const targetCurrentLevel = existing ? Number(existing.role_level) : 0
      if (targetCurrentLevel >= callerRole.level) {
        return c.json(
          {
            error: `cannot modify a member whose current role (${targetCurrentLevel}) is >= your role (${callerRole.level})`,
          },
          403,
        )
      }
    }

    await c.env.AQUILLA_PG.prepare(
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

  const existing = await c.env.AQUILLA_PG.prepare(
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

  // FRO-285 (F-B6): target-level cap — you cannot delete the project_members
  // row of a user whose current level is >= yours, unless you are owner (700).
  const targetCurrentLevel = Number(existing.role_level)
  if (callerRole.level < ROLE.OWNER && targetCurrentLevel >= callerRole.level) {
    return c.json(
      {
        error: `cannot remove a member whose role (${targetCurrentLevel}) is >= your role (${callerRole.level})`,
      },
      403,
    )
  }

  await c.env.AQUILLA_PG.prepare(
    "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
  )
    .bind(projectId, targetUserId)
    .run()

  return c.json({ removed: true })
})

// ──────────────────────────────────────────────────────────────────────────
// DELETE /api/v2/projects/:projectId/files/:fileId — drop projection
// FRO-271: raised from contributor(400) to project_lead(500) — this hard-
// deletes all cells and R2 audio objects; contributors must not be able to
// wipe data they cannot recover.
// ──────────────────────────────────────────────────────────────────────────

projects.delete("/:projectId/files/:fileId", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string
  const fileId = c.req.param("fileId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < 500) {
    return c.json({ error: "project_lead+ required to delete a file" }, 403)
  }

  if (c.env.AQUILLA_PG) {
    try {
      await c.env.AQUILLA_PG.prepare(
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
  /** Client-requested TTL in days. Null = no expiry. Omit = server default (30 days). */
  expires_in_days: z.number().int().min(1).max(365).nullable().optional(),
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
    const { role, email, expires_in_days } = c.req.valid("json")

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
    // Honor client-requested TTL. null = no expiry; undefined = server default (30 days).
    const expiresAt =
      expires_in_days === null
        ? null
        : new Date(
            Date.now() + (expires_in_days !== undefined ? expires_in_days : 30) * 24 * 60 * 60 * 1000
          ).toISOString()

    try {
      await c.env.AQUILLA_PG.prepare(
        `INSERT INTO project_invites
           (token, project_id, role_level, created_by, expires_at, email)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
        .bind(token, projectId, grantedRole, user.id, expiresAt, email ?? null)
        .run()
    } catch (err) {
      console.error("[invites] create failed:", err)
      return c.json({ error: "Failed to create invite" }, 500)
    }

    // Deliver the invite link by email (best-effort; no-op without the EMAIL binding).
    if (email) {
      const baseUrl = c.env.BASE_URL || "https://aquilla.app"
      const joinUrl = `${baseUrl}/join/${token}`
      const proj = await c.env.AQUILLA_PG.prepare(
        "SELECT name FROM projects WHERE id = ?",
      )
        .bind(projectId)
        .first<{ name: string }>()
      const emailPromise = sendProjectInviteEmail(
        c.env,
        email,
        joinUrl,
        proj?.name ?? "a project",
      ).catch((err) => console.warn("[invites] invite email failed:", err))
      // waitUntil only exists with a real ExecutionContext (prod); the test
      // harness has none and the getter throws, so fall back to letting the
      // best-effort promise settle on its own.
      try {
        c.executionCtx.waitUntil(emailPromise)
      } catch {
        void emailPromise
      }
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

// GET /api/v2/projects/:projectId/invites — list active (unused + unexpired) invites.
// Requires project_lead+ role.
projects.get("/:projectId/invites", authMiddleware, async (c) => {
  const user = c.get("user")
  const projectId = c.req.param("projectId") as string

  const role = await resolveProjectRole(c.env, user, projectId)
  if (!role || role.level < INVITE_MIN_ROLE) {
    return c.json({ error: "role >= project_lead required" }, 403)
  }

  const rows = await c.env.AQUILLA_PG.prepare(
    `SELECT token, role_level, created_at, expires_at, email
     FROM project_invites
     WHERE project_id = ?
       AND used_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
     ORDER BY created_at DESC`,
  )
    .bind(projectId)
    .all<{
      token: string
      role_level: number
      created_at: string
      expires_at: string | null
      email: string | null
    }>()

  return c.json({
    invites: (rows.results ?? []).map((r) => ({
      token: r.token,
      role: { level: r.role_level, name: roleNameFor(r.role_level) },
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      email: r.email ?? null,
    })),
  })
})

// GET /api/v2/projects/invite-preview/:token — public, no JWT required.
projects.get("/invite-preview/:token", async (c) => {
  const token = c.req.param("token") as string
  if (!token || token.length < 8) {
    return c.json({ error: "Invalid token" }, 404)
  }

  const invite = await c.env.AQUILLA_PG.prepare(
    `SELECT token, project_id, role_level, created_by, created_at,
            expires_at, used_by, used_at, email
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
      return c.json({ error: "Invite expired", code: "time_expired" }, 410)
    }
  }
  if (invite.used_at) {
    return c.json({ error: "Invite already used", code: "used" }, 410)
  }

  const project = await c.env.AQUILLA_PG.prepare(
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
    email: invite.email ?? null,
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

    const invite = await c.env.AQUILLA_PG.prepare(
      `SELECT token, project_id, role_level, created_by, created_at,
              expires_at, used_by, used_at, email
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
        return c.json({ error: "Invite expired", code: "time_expired" }, 410)
      }
    }
    if (invite.used_at && invite.used_by !== user.id) {
      return c.json({ error: "Invite already used", code: "used" }, 410)
    }

    // Email-bound invites: require the redeemer's account email to match
    // (case-insensitive). Open-link invites (null email) are unrestricted.
    if (
      invite.email &&
      invite.email.toLowerCase() !== user.email.toLowerCase()
    ) {
      return c.json(
        { error: "This invite was sent to a different email address." },
        403,
      )
    }

    // Guard: can't join an archived project via invite.
    const project = await c.env.AQUILLA_PG.prepare(
      `SELECT id, archived_at FROM projects WHERE id = ?`,
    )
      .bind(invite.project_id)
      .first<{ id: string; archived_at: string | null }>()
    if (!project) {
      return c.json({ error: "Project not found" }, 404)
    }
    if (project.archived_at) {
      return c.json({ error: "Project is archived" }, 410)
    }

    const existing = await c.env.AQUILLA_PG.prepare(
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
      }
      // Atomic stamp: only the first concurrent redeemer wins; subsequent
      // concurrent calls lose the WHERE race and are treated as same-user re-redeem.
      await c.env.AQUILLA_PG.prepare(
        `UPDATE project_invites
         SET used_by = ?, used_at = CURRENT_TIMESTAMP
         WHERE token = ? AND used_at IS NULL`,
      )
        .bind(user.id, token)
        .run()
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

  const result = await c.env.AQUILLA_PG.prepare(
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
