// Platform-operator (site-wide admin) surface — read-only, cross-tenant.
//
// Every route here bypasses the org-scoped 403 guards used elsewhere, so the
// entire router is mounted behind `requirePlatformAdmin` (which itself runs
// after `authMiddleware`). These are deliberately read-only: listing orgs,
// users, projects, a top-line rollup, and the cross-tenant activity feed.
// Mutating / break-glass actions are intentionally out of scope for v1 and
// will land as individually-audited endpoints.
//
// Routes (mounted at /api/v2/admin):
//   GET /me        — { isPlatformAdmin: true } (only reachable past the gate)
//   GET /overview  — top-line counts (orgs, users, projects, active-7d)
//   GET /orgs      — every org + owner + member/project counts
//   GET /users     — every user
//   GET /projects  — every project + org/creator + cell/word rollup
//   GET /activity  — cross-tenant activity_logs feed (?limit, ?since)

import { Hono } from "hono"
import { authMiddleware, type AuthHonoEnv } from "../middleware/auth"
import { requirePlatformAdmin } from "../middleware/platform-admin"

const admin = new Hono<AuthHonoEnv>()

// auth first (hydrate user), then the platform-admin gate. Order matters:
// the gate reads c.get("user").
admin.use("*", authMiddleware)
admin.use("*", requirePlatformAdmin)

/**
 * GET /api/v2/admin/me — liveness/identity probe for the SPA. Reaching this
 * at all means the caller passed the gate, so the body is a constant. The
 * frontend calls it to decide whether to render the /admin route; non-admins
 * get a 403 and never see it.
 */
admin.get("/me", (c) => {
  const user = c.get("user")
  return c.json({ isPlatformAdmin: true, username: user.username })
})

/** GET /api/v2/admin/overview — top-line platform rollup. */
admin.get("/overview", async (c) => {
  const db = c.env.AQUILLA_DB
  // One round-trip per scalar; D1 has no multi-statement query, but these are
  // cheap COUNT(*)s. active7d = users with org activity in the last 7 days.
  const [orgs, teams, users, projects, archived, active7d] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM organizations").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM groups").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NULL").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM projects WHERE archived_at IS NOT NULL").first<{ n: number }>(),
    db
      .prepare(
        "SELECT COUNT(DISTINCT user_id) AS n FROM org_members WHERE last_active_at IS NOT NULL AND last_active_at >= now() - interval '7 days'",
      )
      .first<{ n: number }>(),
  ])
  return c.json({
    orgs: orgs?.n ?? 0,
    teams: teams?.n ?? 0,
    users: users?.n ?? 0,
    activeProjects: projects?.n ?? 0,
    archivedProjects: archived?.n ?? 0,
    activeUsers7d: active7d?.n ?? 0,
  })
})

/** GET /api/v2/admin/orgs — every org with owner + member/project counts. */
admin.get("/orgs", async (c) => {
  const { results } = await c.env.AQUILLA_DB.prepare(
    `SELECT o.id, o.name, o.created_at,
            u.username AS owner_username,
            (SELECT COUNT(*) FROM org_members m WHERE m.org_id = o.id) AS member_count,
            (SELECT COUNT(*) FROM projects p WHERE p.org_id = o.id AND p.archived_at IS NULL) AS project_count
       FROM organizations o
       LEFT JOIN users u ON u.id = o.owner_user_id
      ORDER BY o.created_at DESC`,
  ).all<{
    id: number
    name: string | null
    created_at: string
    owner_username: string | null
    member_count: number
    project_count: number
  }>()
  return c.json({
    orgs: results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      ownerUsername: r.owner_username,
      memberCount: r.member_count,
      projectCount: r.project_count,
    })),
  })
})

/** GET /api/v2/admin/teams — every group ("team") with org + member/grant counts. */
admin.get("/teams", async (c) => {
  const { results } = await c.env.AQUILLA_DB.prepare(
    `SELECT g.id, g.name, g.created_at, g.org_id,
            o.name AS org_name,
            (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM group_project_grants gp WHERE gp.group_id = g.id) AS project_count
       FROM groups g
       LEFT JOIN organizations o ON o.id = g.org_id
      ORDER BY o.name, g.name`,
  ).all<{
    id: number
    name: string
    created_at: string
    org_id: number
    org_name: string | null
    member_count: number
    project_count: number
  }>()
  return c.json({
    teams: results.map((r) => ({
      id: r.id,
      name: r.name,
      createdAt: r.created_at,
      orgId: r.org_id,
      orgName: r.org_name,
      memberCount: r.member_count,
      projectCount: r.project_count,
    })),
  })
})

/** GET /api/v2/admin/users — every user (no password hashes). */
admin.get("/users", async (c) => {
  const { results } = await c.env.AQUILLA_DB.prepare(
    `SELECT u.id, u.username, u.email, u.display_name, u.created_at,
            (SELECT COUNT(*) FROM org_members m WHERE m.user_id = u.id) AS org_count,
            (SELECT MAX(last_active_at) FROM org_members m WHERE m.user_id = u.id) AS last_active_at
       FROM users u
      ORDER BY u.created_at DESC`,
  ).all<{
    id: number
    username: string
    email: string
    display_name: string | null
    created_at: string
    org_count: number
    last_active_at: string | null
  }>()
  return c.json({
    users: results.map((r) => ({
      id: r.id,
      username: r.username,
      email: r.email,
      displayName: r.display_name,
      createdAt: r.created_at,
      orgCount: r.org_count,
      lastActiveAt: r.last_active_at,
    })),
  })
})

/** GET /api/v2/admin/projects — every project with org/creator + rollup. */
admin.get("/projects", async (c) => {
  const { results } = await c.env.AQUILLA_DB.prepare(
    `SELECT p.id, p.name, p.org_id, p.archived_at, p.created_at, p.deadline_at,
            o.name AS org_name,
            u.username AS creator_username,
            COALESCE(SUM(f.cell_count), 0) AS total_cells,
            COALESCE(SUM(f.approved_count), 0) AS validated_cells,
            COALESCE(SUM(f.word_count), 0) AS word_count,
            MAX(f.last_edit_at) AS last_edit_at
       FROM projects p
       LEFT JOIN organizations o ON o.id = p.org_id
       LEFT JOIN users u ON u.id = p.created_by
       LEFT JOIN files f ON f.project_id = p.id
      GROUP BY p.id
      ORDER BY p.created_at DESC`,
  ).all<{
    id: string
    name: string
    org_id: number | null
    org_name: string | null
    archived_at: string | null
    created_at: string
    deadline_at: string | null
    creator_username: string | null
    total_cells: number
    validated_cells: number
    word_count: number
    last_edit_at: number | null
  }>()
  return c.json({
    projects: results.map((r) => ({
      id: r.id,
      name: r.name,
      orgId: r.org_id,
      orgName: r.org_name,
      archived: r.archived_at != null,
      createdAt: r.created_at,
      deadlineAt: r.deadline_at,
      creatorUsername: r.creator_username,
      totalCells: r.total_cells,
      validatedCells: r.validated_cells,
      wordCount: r.word_count,
      lastEditAt: r.last_edit_at,
    })),
  })
})

/**
 * GET /api/v2/admin/activity — cross-tenant activity feed. `limit` defaults
 * to 100 and is capped at 500; `since` is an optional ISO timestamp lower
 * bound. Newest first.
 */
admin.get("/activity", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100
  const since = c.req.query("since")

  const where = since ? "WHERE a.timestamp >= ?" : ""
  const stmt = c.env.AQUILLA_DB.prepare(
    `SELECT a.id, a.user_id, a.activity_type, a.description, a.timestamp,
            u.username
       FROM activity_logs a
       LEFT JOIN users u ON u.id = a.user_id
       ${where}
      ORDER BY a.timestamp DESC, a.id DESC
      LIMIT ?`,
  )
  const bound = since ? stmt.bind(since, limit) : stmt.bind(limit)
  const { results } = await bound.all<{
    id: number
    user_id: number
    activity_type: string | null
    description: string | null
    timestamp: string
    username: string | null
  }>()
  return c.json({
    activity: results.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      type: r.activity_type,
      description: r.description,
      timestamp: r.timestamp,
    })),
  })
})

export default admin
