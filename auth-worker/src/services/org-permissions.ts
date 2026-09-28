// Organization-permission helpers for the codex-web identity/project backend.

import type { Env, AuthUser } from "../types"
import { ORG_WIDE_ACCESS_FLOOR, resolveProjectRole } from "./project-permissions"
import { isPlatformAdminEmail } from "../middleware/platform-admin"
import { planUnitCountsSql, aoeTodayIso } from "../../../db/shared/plan-units"
import { orgPathContribution } from "../../../db/shared/project-roles"
import { takeSoundsOnItsTrackSql } from "../../../db/shared/audio-progress"

/** Map numeric role level to a human-readable name. Used for secondarySources. */
function roleNameForLevel(level: number): string {
  if (level >= 700) return "owner"
  if (level >= 500) return "project_lead"
  if (level >= 300) return "maintainer"
  if (level >= 200) return "contributor"
  return "viewer"
}

export interface UserOrg {
  id: number
  name: string | null
  /** 700 — caller is always owner of their personal org. */
  role: number
}

/**
 * Return the user's owned organization, lazy-creating one if absent.
 * Personal orgs are created without a Stripe customer. The caller becomes
 * a role-700 owner.
 */
export async function getOrCreateUserOrg(
  env: Env,
  user: AuthUser,
): Promise<UserOrg> {
  const existing = await env.AQUILLA_PG.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1",
  )
    .bind(user.id)
    .first<{ id: number; name: string | null }>()

  if (existing) {
    return { id: existing.id, name: existing.name, role: 700 }
  }

  const name = `${user.username}'s workspace`
  const inserted = await env.AQUILLA_PG.prepare(
    `INSERT INTO organizations (name, owner_user_id, billing_scope)
     VALUES (?, ?, 'personal')
     ON CONFLICT (owner_user_id) WHERE billing_scope = 'personal'
     DO UPDATE SET billing_scope = EXCLUDED.billing_scope RETURNING id`,
  )
    .bind(name, user.id)
    .first<{ id: number }>()
  if (!inserted) throw new Error("failed to insert organization row")

  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (?, ?, 700, ?)
     ON CONFLICT(org_id, user_id) DO NOTHING`,
  )
    .bind(inserted.id, user.id, user.id)
    .run()

  return { id: inserted.id, name, role: 700 }
}

export async function createOrgForUser(env: Env, user: AuthUser, name: string): Promise<{ id: number; name: string }> {
  const inserted = await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (name, owner_user_id, billing_scope) VALUES (?, ?, 'team') RETURNING id",
  ).bind(name, user.id).first<{ id: number }>()
  if (!inserted) throw new Error("failed to insert organization")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?) ON CONFLICT(org_id, user_id) DO NOTHING",
  ).bind(inserted.id, user.id, user.id).run()
  return { id: inserted.id, name }
}

export async function renameOrg(env: Env, orgId: number, name: string): Promise<void> {
  await env.AQUILLA_PG.prepare(
    "UPDATE organizations SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(name, orgId).run()
}

export interface UserOrgSummary {
  id: number
  name: string | null
  role: number
}

/**
 * Every org the user belongs to: owned orgs (role 700) unioned with
 * org_members rows (role per row). Owner wins on conflict. Lazy-creates the
 * personal org if the user has none yet, so the switcher always has >=1 entry.
 */
export async function listUserOrgs(env: Env, user: AuthUser): Promise<UserOrgSummary[]> {
  const byId = new Map<number, UserOrgSummary>()

  const owned = await env.AQUILLA_PG.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ?",
  ).bind(user.id).all<{ id: number; name: string | null }>()
  for (const o of owned.results ?? []) {
    byId.set(o.id, { id: o.id, name: o.name, role: 700 })
  }

  const memberships = await env.AQUILLA_PG.prepare(
    `SELECT o.id AS id, o.name AS name, om.role_level AS role_level
       FROM org_members om
       JOIN organizations o ON o.id = om.org_id
      WHERE om.user_id = ?`,
  ).bind(user.id).all<{ id: number; name: string | null; role_level: number }>()
  for (const m of memberships.results ?? []) {
    const existing = byId.get(m.id)
    if (!existing || m.role_level > existing.role) {
      byId.set(m.id, { id: m.id, name: m.name, role: m.role_level })
    }
  }

  if (byId.size === 0) {
    const personal = await getOrCreateUserOrg(env, user)
    byId.set(personal.id, { id: personal.id, name: personal.name, role: personal.role })
  }

  return Array.from(byId.values()).sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""))
}

/** First page of the org-switcher catalog (platform-admin append). */
export const ORG_DIRECTORY_DEFAULT_LIMIT = 40
export const ORG_DIRECTORY_MAX_LIMIT = 100

export function encodeOrgDirectoryCursor(id: number, name: string | null): string {
  return `${id}:${encodeURIComponent(name ?? "")}`
}

export function decodeOrgDirectoryCursor(raw: string): { id: number; name: string } | null {
  const sep = raw.indexOf(":")
  if (sep < 0) return null
  const id = Number(raw.slice(0, sep))
  if (!Number.isInteger(id) || id < 1) return null
  try {
    return { id, name: decodeURIComponent(raw.slice(sep + 1)) }
  } catch {
    return null
  }
}

export function clampOrgDirectoryLimit(raw: string | undefined): number {
  const n = raw == null || raw === "" ? ORG_DIRECTORY_DEFAULT_LIMIT : Number(raw)
  if (!Number.isFinite(n)) return ORG_DIRECTORY_DEFAULT_LIMIT
  return Math.min(ORG_DIRECTORY_MAX_LIMIT, Math.max(1, Math.floor(n)))
}

/** Same page size as the org switcher — project tables and pickers share it. */
export const PROJECT_DIRECTORY_DEFAULT_LIMIT = ORG_DIRECTORY_DEFAULT_LIMIT
export const PROJECT_DIRECTORY_MAX_LIMIT = ORG_DIRECTORY_MAX_LIMIT

export const clampProjectDirectoryLimit = clampOrgDirectoryLimit

/** Same page size as the org switcher / project tables. */
export const TEAM_DIRECTORY_DEFAULT_LIMIT = ORG_DIRECTORY_DEFAULT_LIMIT
export const TEAM_DIRECTORY_MAX_LIMIT = ORG_DIRECTORY_MAX_LIMIT
export const clampTeamDirectoryLimit = clampOrgDirectoryLimit
export const encodeTeamDirectoryCursor = encodeOrgDirectoryCursor
export const decodeTeamDirectoryCursor = decodeOrgDirectoryCursor

export function encodeProjectDirectoryCursor(id: string, name: string): string {
  return `${encodeURIComponent(id)}:${encodeURIComponent(name)}`
}

export function decodeProjectDirectoryCursor(raw: string): { id: string; name: string } | null {
  const sep = raw.indexOf(":")
  if (sep < 0) return null
  try {
    const id = decodeURIComponent(raw.slice(0, sep))
    const name = decodeURIComponent(raw.slice(sep + 1))
    if (!id) return null
    return { id, name }
  } catch {
    return null
  }
}

/**
 * One page of orgs the caller does not already reach via membership or a
 * project grant. Used by GET /orgs?limit= for the switcher's infinite list —
 * never by the unparameterized memberships fetch (session boot).
 */
export async function listPlatformAdminOrgsPage(
  env: Env,
  opts: {
    excludeIds: ReadonlySet<number>
    /** Lowercased substring; empty string matches all names. */
    q: string
    limit: number
    cursor: { id: number; name: string } | null
  },
): Promise<{ orgs: Array<{ id: number; name: string | null }>; nextCursor: string | null }> {
  const binds: unknown[] = []
  const where: string[] = []

  if (opts.q) {
    where.push("strpos(lower(coalesce(name, '')), ?) > 0")
    binds.push(opts.q)
  }

  const exclude = [...opts.excludeIds]
  if (exclude.length > 0) {
    where.push(`id NOT IN (${exclude.map(() => "?").join(", ")})`)
    binds.push(...exclude)
  }

  if (opts.cursor) {
    const cursorName = opts.cursor.name.toLowerCase()
    where.push(
      "(lower(coalesce(name, '')) > ? OR (lower(coalesce(name, '')) = ? AND id > ?))",
    )
    binds.push(cursorName, cursorName, opts.cursor.id)
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""
  binds.push(opts.limit + 1)

  const rows = await env.AQUILLA_PG.prepare(
    `SELECT id, name FROM organizations
      ${whereSql}
      ORDER BY lower(coalesce(name, '')), id
      LIMIT ?`,
  )
    .bind(...binds)
    .all<{ id: number; name: string | null }>()

  const list = rows.results ?? []
  const hasMore = list.length > opts.limit
  const page = hasMore ? list.slice(0, opts.limit) : list
  const last = page[page.length - 1]
  return {
    orgs: page,
    nextCursor: hasMore && last ? encodeOrgDirectoryCursor(last.id, last.name) : null,
  }
}

/**
 * Orgs the caller can reach via a project-level grant (direct, group, or
 * creator) — including orgs they also belong to. GET /orgs uses this to keep
 * those orgs off the platform-admin append, so a real guest grant surfaces as
 * Guest in the org picker instead of Admin.
 */
export async function listProjectGrantOrgIds(env: Env, userId: number): Promise<Set<number>> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT DISTINCT p.org_id AS id
       FROM projects p
      WHERE p.org_id IS NOT NULL
        AND (
          p.created_by = ?
          OR EXISTS (
            SELECT 1 FROM project_members pm
             WHERE pm.project_id = p.id AND pm.user_id = ?
          )
          OR EXISTS (
            SELECT 1 FROM group_project_grants gpg
            JOIN group_members gm ON gm.group_id = gpg.group_id
            WHERE gpg.project_id = p.id AND gm.user_id = ?
          )
        )`,
  )
    .bind(userId, userId, userId)
    .all<{ id: number }>()
  return new Set((rows.results ?? []).map((r) => r.id))
}

/** Return the role_level of (org_id, user_id) or null if no row. */
export async function getOrgMemberRole(
  env: Env,
  orgId: number,
  userId: number,
): Promise<number | null> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(orgId, userId)
    .first<{ role_level: number }>()
  return row?.role_level ?? null
}

/**
 * Caller-side org guard: the caller's effective role on an org. Platform
 * operators (ADMIN_EMAILS) resolve as owner (700) on every org — the
 * org-side twin of the "platform" path in resolveProjectRole. Route guards
 * checking the CALLER must use this; keep raw getOrgMemberRole for
 * target-user lookups (e.g. "is the invitee an org member?"), where
 * platform-admin status must not leak in.
 */
export async function getEffectiveOrgRole(
  env: Env,
  orgId: number,
  user: AuthUser,
): Promise<number | null> {
  const membership = await getOrgMemberRole(env, orgId, user.id)
  if (isPlatformAdminEmail(env, user.email)) {
    return Math.max(membership ?? 0, 700)
  }
  return membership
}

export interface OrgMemberWithUser {
  userId: number
  username: string
  email: string | null
  roleLevel: number
  /** ISO timestamp of last project-context activity, or NULL. */
  lastActiveAt: string | null
}

/** All org members joined to users for display. */
export async function listOrgMembersWithUsers(
  env: Env,
  orgId: number,
): Promise<OrgMemberWithUser[]> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT om.user_id AS user_id, u.username AS username, u.email AS email,
            om.role_level AS role_level, om.last_active_at AS last_active_at
     FROM org_members om
     INNER JOIN users u ON u.id = om.user_id
     WHERE om.org_id = ?
     ORDER BY om.role_level DESC, u.username ASC`,
  )
    .bind(orgId)
    .all<{
      user_id: number
      username: string
      email: string | null
      role_level: number
      last_active_at: string | null
    }>()

  return (result.results ?? []).map((r) => ({
    userId: r.user_id,
    username: r.username,
    email: r.email ?? null,
    roleLevel: r.role_level,
    lastActiveAt: r.last_active_at,
  }))
}

export const ORG_ACTIVITY_DEBOUNCE_MS = 5 * 60 * 1000
/** Isolate-local "(orgId:userId) → last bump ms". */
const orgActivityBumpedAt = new Map<string, number>()

/** Test hook: forget every isolate-local bump timestamp. */
export function clearOrgActivityDebounce(): void {
  orgActivityBumpedAt.clear()
}

/**
 * Bump org_members.last_active_at for (userId, orgId), debounced to once per
 * 5 minutes per pair. Fire-and-forget: a failed write doesn't fail the
 * caller's actual request.
 */
export async function bumpOrgActivity(
  env: Env,
  userId: number,
  orgId: number | null,
): Promise<void> {
  if (orgId == null) return
  // Perf (2026-09): the WHERE clause below only debounced the ROW; the UPDATE
  // statement itself still ran on every /orgs/me. Skip the statement entirely
  // when this isolate bumped the pair within the window. Another isolate may
  // still issue a no-op UPDATE — the WHERE clause remains the row guard.
  const key = `${orgId}:${userId}`
  const now = Date.now()
  const last = orgActivityBumpedAt.get(key)
  if (last != null && now - last < ORG_ACTIVITY_DEBOUNCE_MS) return
  orgActivityBumpedAt.set(key, now)
  try {
    // One round-trip: bump the org row AND record "this user used the app
    // today" for retention (user_activity_days, see migration 0090). The CTE
    // keeps the day insert independent of the UPDATE's WHERE, so a user whose
    // row another isolate bumped seconds ago still gets today's activity day.
    await env.AQUILLA_PG.prepare(
      `WITH bump AS (
         UPDATE org_members
            SET last_active_at = CURRENT_TIMESTAMP
          WHERE org_id = ? AND user_id = ?
            AND (last_active_at IS NULL
                 OR last_active_at < now() - interval '5 minutes')
       )
       INSERT INTO user_activity_days (user_id, day)
       VALUES (?, (now() AT TIME ZONE 'UTC')::date)
       ON CONFLICT DO NOTHING`,
    )
      .bind(orgId, userId, userId)
      .run()
  } catch (err) {
    console.warn("bumpOrgActivity failed (non-fatal):", err)
  }
}

export interface PendingOrgInvite {
  token: string
  projectId: string
  projectName: string
  roleLevel: number
  createdByUserId: number
  createdByUsername: string
  createdAt: string
  expiresAt: string | null
  /** Recipient email for targeted invites; null for open links. */
  email: string | null
}

/** Unredeemed, unexpired project_invites for projects in this org. */
export async function listPendingInvitesInOrg(
  env: Env,
  orgId: number,
): Promise<PendingOrgInvite[]> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT pi.token AS token,
            pi.project_id AS project_id,
            p.name AS project_name,
            pi.role_level AS role_level,
            pi.created_by AS created_by_user_id,
            cu.username AS created_by_username,
            pi.created_at AS created_at,
            pi.expires_at AS expires_at,
            pi.email AS email
       FROM project_invites pi
       INNER JOIN projects p ON p.id = pi.project_id
       INNER JOIN users cu ON cu.id = pi.created_by
      WHERE p.org_id = ?
        AND pi.used_by IS NULL
        AND (pi.expires_at IS NULL OR pi.expires_at > CURRENT_TIMESTAMP)
      ORDER BY pi.created_at DESC`,
  )
    .bind(orgId)
    .all<{
      token: string
      project_id: string
      project_name: string
      role_level: number
      created_by_user_id: number
      created_by_username: string
      created_at: string
      expires_at: string | null
      email: string | null
    }>()

  return (result.results ?? []).map((r) => ({
    token: r.token,
    projectId: r.project_id,
    projectName: r.project_name,
    roleLevel: r.role_level,
    createdByUserId: r.created_by_user_id,
    createdByUsername: r.created_by_username,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    email: r.email,
  }))
}

export interface SecondarySrc {
  source: "override" | "group" | "org" | "creator"
  level: number
  name: string
}

export interface EffectiveMember {
  userId: number
  username: string
  /** Account email when known; null only if the users row has none. */
  email: string | null
  roleLevel: number
  /** Path that produced the user's max-wins role (AD-12). */
  source: "override" | "group" | "org" | "creator"
  /**
   * Every contributing path whose level > 0 EXCEPT the winning one.
   * Populated by listEffectiveProjectMembers; empty array when the user has
   * access through only one path.
   */
  secondarySources: SecondarySrc[]
}

/**
 * Effective members for a project — per AD-12, max-wins across direct +
 * group + org + creator. A user gets one row, attributed to whichever path
 * produced the highest role_level. Ties resolve by declaration order
 * (override > group > org > creator) so an explicit project grant gets
 * attribution credit when it ties with an inherited grant.
 *
 * Per spec 02-foundations.md AD-12 "Required ops surfaces (members UI)":
 * the per-path breakdown is "non-negotiable in v1". That richer surface
 * lands in the members-panel work (Pass C); this function returns just the
 * max-wins row to keep the existing members endpoint coherent for now.
 */
export async function listEffectiveProjectMembers(
  env: Env,
  projectId: string,
  orgId: number | null,
  createdBy: number,
): Promise<EffectiveMember[]> {
  // Each path is fetched separately and merged via max-wins so attribution
  // is exact (a JOIN-based approach would lose per-user attribution).
  const direct = await env.AQUILLA_PG.prepare(
    `SELECT pm.user_id AS user_id, u.username AS username, u.email AS email, pm.role_level AS role_level
     FROM project_members pm
     INNER JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?`,
  )
    .bind(projectId)
    .all<{ user_id: number; username: string; email: string | null; role_level: number }>()

  // Collect ALL per-path contributions keyed by userId, then derive the
  // winner and secondarySources in a second pass.
  type PathEntry = { source: EffectiveMember["source"]; level: number; priority: number }
  const allPaths = new Map<number, { username: string; email: string | null; paths: PathEntry[] }>()

  const record = (
    userId: number,
    username: string,
    email: string | null,
    source: EffectiveMember["source"],
    level: number,
  ): void => {
    const existing = allPaths.get(userId)
    if (!existing) {
      allPaths.set(userId, { username, email, paths: [] })
    } else if (!existing.email && email) {
      existing.email = email
    }
    allPaths.get(userId)!.paths.push({ source, level, priority: SOURCE_PRIORITY[source] })
  }

  for (const r of direct.results ?? []) {
    record(r.user_id, r.username, r.email, "override", r.role_level)
  }

  // AD-12: surface every user who reaches the project via a group attached
  // to it. MAX-aggregate across group memberships gives the user's best
  // group-level grant; the per-group breakdown is a Pass C concern.
  const groupRows = await env.AQUILLA_PG.prepare(
    `SELECT gm.user_id AS user_id,
            u.username AS username,
            u.email AS email,
            MAX(gpg.role_level) AS role_level
       FROM group_project_grants gpg
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN users u          ON u.id = gm.user_id
      WHERE gpg.project_id = ?
      GROUP BY gm.user_id, u.username, u.email`,
  )
    .bind(projectId)
    .all<{ user_id: number; username: string; email: string | null; role_level: number | null }>()

  for (const r of groupRows.results ?? []) {
    if (r.role_level == null) continue
    record(r.user_id, r.username, r.email, "group", r.role_level)
  }

  if (orgId != null) {
    const orgMembers = await env.AQUILLA_PG.prepare(
      `SELECT om.user_id AS user_id, u.username AS username, u.email AS email, om.role_level AS role_level
       FROM org_members om
       INNER JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ?`,
    )
      .bind(orgId)
      .all<{ user_id: number; username: string; email: string | null; role_level: number }>()

    // Direct and group paths are already recorded above, so `allPaths` tells
    // us which other paths each org member holds on THIS project — exactly
    // what orgPathContribution needs (AQU-435 floor + AQU-1274 no silent
    // demotion). Same rule as the resolver, so this roster can't disagree
    // with what enforcement does.
    for (const r of orgMembers.results ?? []) {
      const existing = allPaths.get(r.user_id)?.paths ?? []
      const level = orgPathContribution({
        orgLevel: r.role_level,
        hasDirectGrant: existing.some((p) => p.source === "override"),
        hasGroupGrant: existing.some((p) => p.source === "group"),
      })
      if (level == null) continue
      record(r.user_id, r.username, r.email, "org", level)
    }
  }

  const creatorRow = await env.AQUILLA_PG.prepare(
    "SELECT id, username, email FROM users WHERE id = ?",
  )
    .bind(createdBy)
    .first<{ id: number; username: string; email: string | null }>()
  if (creatorRow) {
    record(creatorRow.id, creatorRow.username, creatorRow.email, "creator", 700)
  }

  // Derive winner + secondarySources for each user.
  const results: EffectiveMember[] = []
  for (const [userId, { username, email, paths }] of allPaths) {
    // Sort paths: highest level first, ties broken by priority (higher wins).
    paths.sort((a, b) => b.level - a.level || b.priority - a.priority)
    const winner = paths[0]
    const secondary: SecondarySrc[] = paths
      .slice(1)
      .filter((p) => p.level > 0)
      .map((p) => ({ source: p.source, level: p.level, name: roleNameForLevel(p.level) }))
    results.push({
      userId,
      username,
      email,
      roleLevel: winner.level,
      source: winner.source,
      secondarySources: secondary,
    })
  }

  return results.sort(
    (a, b) => b.roleLevel - a.roleLevel || a.username.localeCompare(b.username),
  )
}

const SOURCE_PRIORITY: Record<EffectiveMember["source"], number> = {
  override: 4,
  group: 3,
  org: 2,
  creator: 1,
}

type PathEntry = { source: EffectiveMember["source"]; level: number; priority: number }

/**
 * Given every per-path contribution for the users on one project, derive each
 * user's max-wins row (winner + secondarySources), sorted for display. Shared
 * by listEffectiveProjectMembers and listEffectiveMembersForOrg so both agree
 * on attribution semantics.
 */
function deriveEffectiveMembers(
  allPaths: Map<number, { username: string; email?: string | null; paths: PathEntry[] }>,
): EffectiveMember[] {
  const results: EffectiveMember[] = []
  for (const [userId, { username, email = null, paths }] of allPaths) {
    paths.sort((a, b) => b.level - a.level || b.priority - a.priority)
    const winner = paths[0]
    const secondary: SecondarySrc[] = paths
      .slice(1)
      .filter((p) => p.level > 0)
      .map((p) => ({ source: p.source, level: p.level, name: roleNameForLevel(p.level) }))
    results.push({
      userId,
      username,
      email,
      roleLevel: winner.level,
      source: winner.source,
      secondarySources: secondary,
    })
  }
  return results.sort(
    (a, b) => b.roleLevel - a.roleLevel || a.username.localeCompare(b.username),
  )
}

export interface ProjectEffectiveMembers {
  projectId: string
  members: EffectiveMember[]
}

/**
 * Batched membership-matrix resolver (AQU-218). Computes effective members for
 * EVERY non-archived project the viewer can access in `orgId`, in a small
 * constant number of queries regardless of project count — replacing the
 * client's per-project /:projectId/members fan-out that flooded the connection
 * pool (~4 queries × N projects). org_members is fetched ONCE here, not once
 * per project; direct/group/creator paths are resolved set-based with IN().
 *
 * Result is per-project max-wins rows identical to listEffectiveProjectMembers
 * for each project, so the matrix renders unchanged.
 */
export async function listEffectiveMembersForOrg(
  env: Env,
  orgId: number,
  viewerId: number,
): Promise<ProjectEffectiveMembers[]> {
  // 1. The viewer's accessible non-archived projects in this org. Mirrors the
  //    access predicate of GET /api/v2/projects so the matrix columns match.
  const accessible = await env.AQUILLA_PG.prepare(
    `SELECT p.id AS id, p.created_by AS created_by
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       LEFT JOIN org_members om     ON om.org_id = p.org_id AND om.user_id = ?
       LEFT JOIN (
         SELECT gpg.project_id, MAX(gpg.role_level) AS max_grant
           FROM group_project_grants gpg
           JOIN group_members gm ON gm.group_id = gpg.group_id
          WHERE gm.user_id = ?
          GROUP BY gpg.project_id
       ) gg ON gg.project_id = p.id
      WHERE p.org_id = ? AND p.archived_at IS NULL
        AND (
          p.created_by = ?
          OR pm.user_id = ?
          OR gg.max_grant IS NOT NULL
          OR (om.user_id = ? AND om.role_level >= ${ORG_WIDE_ACCESS_FLOOR})
        )`,
  )
    .bind(viewerId, viewerId, viewerId, orgId, viewerId, viewerId, viewerId)
    .all<{ id: string; created_by: number }>()

  const projects = accessible.results ?? []
  if (projects.length === 0) return []

  const projectIds = projects.map((p) => p.id)
  const placeholders = projectIds.map(() => "?").join(", ")

  // 2. org_members — fetched ONCE for the whole matrix (the old hot path that
  //    re-ran this per project). Applies as the "org" path to every project,
  //    since all accessible projects here belong to orgId.
  const orgMembers = await env.AQUILLA_PG.prepare(
    `SELECT om.user_id AS user_id, u.username AS username, om.role_level AS role_level
       FROM org_members om
       INNER JOIN users u ON u.id = om.user_id
      WHERE om.org_id = ?`,
  )
    .bind(orgId)
    .all<{ user_id: number; username: string; role_level: number }>()

  // 3. Direct project_members across all accessible projects, in one query.
  const direct = await env.AQUILLA_PG.prepare(
    `SELECT pm.project_id AS project_id, pm.user_id AS user_id,
            u.username AS username, pm.role_level AS role_level
       FROM project_members pm
       INNER JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id IN (${placeholders})`,
  )
    .bind(...projectIds)
    .all<{ project_id: string; user_id: number; username: string; role_level: number }>()

  // 4. Group grants across all accessible projects, MAX-aggregated per
  //    (project, user) just like the per-project resolver.
  const groups = await env.AQUILLA_PG.prepare(
    `SELECT gpg.project_id AS project_id, gm.user_id AS user_id,
            u.username AS username, MAX(gpg.role_level) AS role_level
       FROM group_project_grants gpg
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN users u          ON u.id = gm.user_id
      WHERE gpg.project_id IN (${placeholders})
      GROUP BY gpg.project_id, gm.user_id, u.username`,
  )
    .bind(...projectIds)
    .all<{ project_id: string; user_id: number; username: string; role_level: number | null }>()

  // 5. Creator usernames, one query for the whole set.
  const creatorIds = [...new Set(projects.map((p) => p.created_by))]
  const creatorPlaceholders = creatorIds.map(() => "?").join(", ")
  const creatorRows = await env.AQUILLA_PG.prepare(
    `SELECT id, username FROM users WHERE id IN (${creatorPlaceholders})`,
  )
    .bind(...creatorIds)
    .all<{ id: number; username: string }>()
  const creatorUsername = new Map<number, string>()
  for (const r of creatorRows.results ?? []) creatorUsername.set(r.id, r.username)

  // Bucket the flat result rows by project, then derive per-project winners.
  const pathsByProject = new Map<string, Map<number, { username: string; paths: PathEntry[] }>>()
  const ensure = (projectId: string): Map<number, { username: string; paths: PathEntry[] }> => {
    let m = pathsByProject.get(projectId)
    if (!m) {
      m = new Map()
      pathsByProject.set(projectId, m)
    }
    return m
  }
  const record = (
    projectId: string,
    userId: number,
    username: string,
    source: EffectiveMember["source"],
    level: number,
  ): void => {
    const m = ensure(projectId)
    if (!m.has(userId)) m.set(userId, { username, paths: [] })
    m.get(userId)!.paths.push({ source, level, priority: SOURCE_PRIORITY[source] })
  }

  for (const r of direct.results ?? []) {
    record(r.project_id, r.user_id, r.username, "override", r.role_level)
  }
  for (const r of groups.results ?? []) {
    if (r.role_level == null) continue
    record(r.project_id, r.user_id, r.username, "group", r.role_level)
  }
  // org + creator paths apply to every accessible project. AQU-435: below
  // Maintainer the org path opens nothing; AQU-1274: it still keeps a team
  // attachment from silently demoting a higher org role. Direct and group
  // paths are recorded above, so the per-project map answers both questions.
  for (const p of projects) {
    const perProject = ensure(p.id)
    for (const om of orgMembers.results ?? []) {
      const existing = perProject.get(om.user_id)?.paths ?? []
      const level = orgPathContribution({
        orgLevel: om.role_level,
        hasDirectGrant: existing.some((x) => x.source === "override"),
        hasGroupGrant: existing.some((x) => x.source === "group"),
      })
      if (level == null) continue
      record(p.id, om.user_id, om.username, "org", level)
    }
    const cu = creatorUsername.get(p.created_by)
    if (cu) record(p.id, p.created_by, cu, "creator", 700)
  }

  return projects.map((p) => ({
    projectId: p.id,
    members: deriveEffectiveMembers(ensure(p.id)),
  }))
}

export interface OrgGroupSummary {
  id: number
  name: string
  memberCount: number
  projectCount: number
  viewerIsMember: boolean
  isInternal: boolean
}

export type TeamDirectoryVisibility = "all" | "internal" | "public"

export type TeamDirectoryPageOpts = {
  q: string
  limit: number
  cursor: { id: number; name: string } | null
  visibility: TeamDirectoryVisibility
}

type OrgGroupDbRow = {
  id: number
  name: string
  is_internal: number | boolean
  member_count: number
  project_count: number
  viewer_is_member: number
}

function mapOrgGroupRow(r: OrgGroupDbRow): OrgGroupSummary {
  return {
    id: r.id,
    name: r.name,
    memberCount: r.member_count,
    projectCount: r.project_count,
    viewerIsMember: r.viewer_is_member === 1,
    isInternal: r.is_internal === 1 || r.is_internal === true,
  }
}

export function parseTeamDirectoryVisibility(raw: string | undefined): TeamDirectoryVisibility {
  if (raw === "internal" || raw === "public" || raw === "all") return raw
  return "all"
}

/**
 * One page (or the full set) of teams in an org, ordered by name. Used by the
 * org Teams table so search and infinite scroll do not dump every group.
 * `memberOnly` is the AQU-789 gate: non-maintainers only see teams they belong to.
 */
export async function listOrgGroupsPage(
  env: Env,
  orgId: number,
  viewerId: number,
  page: TeamDirectoryPageOpts | null,
  access: { memberOnly: boolean },
): Promise<{ groups: OrgGroupSummary[]; nextCursor: string | null }> {
  const extraWhere: string[] = []
  const extraBinds: unknown[] = []
  if (access.memberOnly) {
    extraWhere.push(
      "EXISTS (SELECT 1 FROM group_members gm_vis WHERE gm_vis.group_id = g.id AND gm_vis.user_id = ?)",
    )
    extraBinds.push(viewerId)
  }
  if (page?.q) {
    extraWhere.push("strpos(lower(g.name), ?) > 0")
    extraBinds.push(page.q)
  }
  if (page?.visibility === "internal") extraWhere.push("g.is_internal IS TRUE")
  else if (page?.visibility === "public") extraWhere.push("g.is_internal IS NOT TRUE")
  if (page?.cursor) {
    extraWhere.push("(lower(g.name) > ? OR (lower(g.name) = ? AND g.id > ?))")
    extraBinds.push(page.cursor.name.toLowerCase(), page.cursor.name.toLowerCase(), page.cursor.id)
  }
  const extraWhereSql = extraWhere.length > 0 ? ` AND ${extraWhere.join(" AND ")}` : ""
  const limitSql = page ? " LIMIT ?" : ""
  if (page) extraBinds.push(page.limit + 1)

  const rows = await env.AQUILLA_PG.prepare(
    `SELECT g.id AS id, g.name AS name, g.is_internal AS is_internal,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM group_project_grants gpg WHERE gpg.group_id = g.id) AS project_count,
            (EXISTS (SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?))::int AS viewer_is_member
       FROM groups g
      WHERE g.org_id = ?
        ${extraWhereSql}
      ORDER BY LOWER(g.name), g.id
      ${limitSql}`,
  )
    .bind(viewerId, orgId, ...extraBinds)
    .all<OrgGroupDbRow>()

  const list = rows.results ?? []
  const hasMore = page != null && list.length > page.limit
  const pageRows = hasMore ? list.slice(0, page.limit) : list
  const last = pageRows[pageRows.length - 1]
  return {
    groups: pageRows.map(mapOrgGroupRow),
    nextCursor: hasMore && last ? encodeTeamDirectoryCursor(last.id, last.name) : null,
  }
}

/** Groups in an org, with counts and whether the viewer is a member. */
export async function listOrgGroups(
  env: Env,
  orgId: number,
  viewerId: number,
): Promise<OrgGroupSummary[]> {
  const { groups } = await listOrgGroupsPage(env, orgId, viewerId, null, { memberOnly: false })
  return groups
}

/** ISO-8601 for JSON; Hyperdrive may hand back a Date or a timestamp string. */
function timestampIso(value: string | Date | null | undefined): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    const t = value.getTime()
    return Number.isNaN(t) ? null : value.toISOString()
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString()
}

export interface OrgGroupDetail {
  id: number
  name: string
  description: string | null

  members: Array<{ userId: number; username: string; email: string | null; roleLevel: number | null; addedAt: string | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number; grantedAt: string | null }>
}

/** Members + attached projects of a single group. Null if not in this org. */
export async function getOrgGroupDetail(
  env: Env,
  orgId: number,
  groupId: number,
): Promise<OrgGroupDetail | null> {
  const group = await env.AQUILLA_PG.prepare(
    "SELECT id, name, description FROM groups WHERE id = ? AND org_id = ?",
  )
    .bind(groupId, orgId)
    .first<{ id: number; name: string; description: string | null }>()
  if (!group) return null

  const members = await env.AQUILLA_PG.prepare(
    `SELECT gm.user_id AS user_id, u.username AS username, u.email AS email, om.role_level AS role_level,
            gm.added_at AS added_at
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN org_members om ON om.org_id = ? AND om.user_id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY LOWER(u.username)`,
  )
    .bind(orgId, groupId)
    .all<{ user_id: number; username: string; email: string | null; role_level: number | null; added_at: string | Date | null }>()

  const projects = await env.AQUILLA_PG.prepare(
    `SELECT gpg.project_id AS id, p.name AS name, gpg.role_level AS granted,
            gpg.granted_at AS granted_at
       FROM group_project_grants gpg
       JOIN projects p ON p.id = gpg.project_id
      WHERE gpg.group_id = ? AND p.org_id = ?
      ORDER BY LOWER(p.name)`,
  )
    .bind(groupId, orgId)
    .all<{ id: string; name: string; granted: number; granted_at: string | Date | null }>()

  return {
    id: group.id,
    name: group.name,
    description: group.description ?? null,
    members: (members.results ?? []).map((m) => ({
      userId: m.user_id,
      username: m.username,
      email: m.email ?? null,
      roleLevel: m.role_level,
      addedAt: timestampIso(m.added_at),
    })),
    projects: (projects.results ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      grantedRoleLevel: p.granted,
      grantedAt: timestampIso(p.granted_at),
    })),
  }
}

/** True if a group with this id exists in this org. */
export async function groupExistsInOrg(env: Env, orgId: number, groupId: number): Promise<boolean> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT 1 AS ok FROM groups WHERE id = ? AND org_id = ?",
  ).bind(groupId, orgId).first<{ ok: number }>()
  return row != null
}

export interface GroupRow { id: number; name: string; description: string | null }

/** Create a group. Returns null if the name already exists in the org. */
export async function createGroup(env: Env, orgId: number, name: string, description: string | null, createdBy: number): Promise<GroupRow | null> {
  const existing = await env.AQUILLA_PG.prepare(
    "SELECT id FROM groups WHERE org_id = ? AND name = ?",
  ).bind(orgId, name).first<{ id: number }>()
  if (existing) return null
  const row = await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (org_id, name, description, created_by) VALUES (?, ?, ?, ?) RETURNING id, name, description",
  ).bind(orgId, name, description, createdBy).first<GroupRow>()
  return row
}

/** Update name/description. Returns null on duplicate-name conflict. */
export async function updateGroup(env: Env, orgId: number, groupId: number, name: string | undefined, description: string | undefined): Promise<GroupRow | null> {
  if (name != null) {
    const clash = await env.AQUILLA_PG.prepare(
      "SELECT id FROM groups WHERE org_id = ? AND name = ? AND id != ?",
    ).bind(orgId, name, groupId).first<{ id: number }>()
    if (clash) return null
  }
  await env.AQUILLA_PG.prepare(
    `UPDATE groups SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND org_id = ?`,
  ).bind(name ?? null, description ?? null, groupId, orgId).run()
  return env.AQUILLA_PG.prepare(
    "SELECT id, name, description FROM groups WHERE id = ?",
  ).bind(groupId).first<GroupRow>()
}

/** Delete a group (FK cascades members + grants). */
export async function deleteGroup(env: Env, orgId: number, groupId: number): Promise<void> {
  // The Postgres schema omits FK constraints (migration choice), so cascade the
  // child rows explicitly — SQLite's ON DELETE CASCADE did this for us before.
  await env.AQUILLA_PG.batch([
    env.AQUILLA_PG.prepare("DELETE FROM group_members WHERE group_id = ?").bind(groupId),
    env.AQUILLA_PG.prepare("DELETE FROM group_project_grants WHERE group_id = ?").bind(groupId),
    env.AQUILLA_PG.prepare("DELETE FROM groups WHERE id = ? AND org_id = ?").bind(groupId, orgId),
  ])
}

/** Add an org member to a group. Returns "not-org-member" if the target isn't in the org. */
export async function addGroupMember(env: Env, orgId: number, groupId: number, targetUserId: number, addedBy: number): Promise<"ok" | "not-org-member"> {
  const orgRole = await getOrgMemberRole(env, orgId, targetUserId)
  if (orgRole == null) return "not-org-member"
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO NOTHING",
  ).bind(groupId, targetUserId, addedBy).run()
  return "ok"
}

export async function removeGroupMember(env: Env, groupId: number, userId: number): Promise<void> {
  await env.AQUILLA_PG.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").bind(groupId, userId).run()
}

/** Attach (or re-grant) a project to a group. Returns "cross-org" if the project isn't in this org. */
export async function attachGroupProject(env: Env, orgId: number, groupId: number, projectId: string, roleLevel: number, grantedBy: number): Promise<"ok" | "cross-org" | "no-project"> {
  const proj = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?").bind(projectId).first<{ org_id: number | null }>()
  if (!proj) return "no-project"
  if (proj.org_id !== orgId) return "cross-org"
  await env.AQUILLA_PG.prepare(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, project_id) DO UPDATE SET role_level = excluded.role_level, granted_by = excluded.granted_by`,
  ).bind(groupId, projectId, roleLevel, grantedBy).run()
  return "ok"
}

/** Change the granted role for an existing attachment. Returns false if no attachment. */
export async function updateGroupProjectRole(env: Env, groupId: number, projectId: string, roleLevel: number): Promise<boolean> {
  const existing = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM group_project_grants WHERE group_id = ? AND project_id = ?",
  ).bind(groupId, projectId).first()
  if (!existing) return false
  await env.AQUILLA_PG.prepare(
    "UPDATE group_project_grants SET role_level = ? WHERE group_id = ? AND project_id = ?",
  ).bind(roleLevel, groupId, projectId).run()
  return true
}

export async function detachGroupProject(env: Env, groupId: number, projectId: string): Promise<void> {
  await env.AQUILLA_PG.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?").bind(groupId, projectId).run()
}

/**
 * AQU-538: per-target-language-lane rollup for a project. Aggregated from
 * `file_section_progress` file-scope rows (`scope='file'`) grouped by
 * `target_lang`. `lane: ''` is the default lane (the project's configured
 * `targetLanguage`, labeled client-side) and is always present whenever the
 * project has any file-scope progress rows. `validatedCells` mirrors the
 * per-file progress route: cells whose endorsement count meets the project's
 * `validationCount` threshold (default 1, cap 15). `lastEditAt` is the most
 * recent progress-projection update in the lane (updated on every edit /
 * validation that touches the lane), which avoids a heavy per-lane cells scan.
 */
export interface PortfolioLane {
  lane: string
  totalCells: number
  filledCells: number
  validatedCells: number
  lastEditAt: number | null
}

export interface PortfolioRow { id: string; name: string; totalCells: number; validatedCells: number; filledCells: number; lastEditAt: number | null; audioCells: number; validatedAudioCells: number; recordedMs: number; deadlineAt: string | null; aiDraftedCells: number; sourceLanguage: string | null; targetLanguage: string | null; lanes: PortfolioLane[]; unitsTotal: number; unitsDone: number; unitsOverdue: number }
export interface OrgPortfolioRow extends PortfolioRow { orgId: number }

/** Soft-deleted file in an org the caller can see (Archived → Recently deleted). */
export interface OrgDeletedFile {
  fileId: string
  name: string
  projectId: string
  projectName: string
  fileType: string
  cellCount: number
  deletedAt: number
}

interface PortfolioDbRow {
  org_id: number
  id: string
  name: string
  deadline_at: string | null
  total_cells: number
  validated_cells: number
  filled_cells: number
  ai_drafted_cells: number
  last_edit_at: number | null
  audio_cells: number
  validated_audio_cells: number
  recorded_ms: number
  // AQU-523: project language pair, read from the project_settings JSON blob
  // (the canonical per-project source useProject overlays). Null when unset.
  source_language: string | null
  target_language: string | null
  // AQU-1097: planning units — how many this project has, how many a manager
  // has marked done, and how many are past their target date without a mark.
  units_total: number
  units_done: number
  units_overdue: number
}

function mapPortfolioRow(r: PortfolioDbRow, lanesByProject: Map<string, PortfolioLane[]>): PortfolioRow {
  return {
    id: r.id,
    name: r.name,
    totalCells: r.total_cells,
    validatedCells: r.validated_cells,
    filledCells: r.filled_cells,
    aiDraftedCells: r.ai_drafted_cells,
    lastEditAt: r.last_edit_at,
    audioCells: r.audio_cells,
    validatedAudioCells: r.validated_audio_cells,
    recordedMs: r.recorded_ms,
    deadlineAt: r.deadline_at,
    // "" (empty settings default) is normalized to null so the client shows a
    // graceful "no language set" rather than a blank/broken "→" (AQU-523).
    sourceLanguage: r.source_language || null,
    targetLanguage: r.target_language || null,
    lanes: lanesByProject.get(r.id) ?? [],
    unitsTotal: Number(r.units_total) || 0,
    unitsDone: Number(r.units_done) || 0,
    unitsOverdue: Number(r.units_overdue) || 0,
  }
}

const MAX_VALIDATION_LEVEL = 15

interface LaneDbRow {
  project_id: string
  target_lang: string
  total_count: number | string
  filled_count: number | string
  validator_histogram: Record<string, number> | string | null
  updated_at: number | string | null
  // AQU-1083: the structural subset of each of the three above, so a lane can
  // subtract at read time exactly as the headline numbers beside it do.
  structural_count: number | string | null
  structural_filled_count: number | string | null
  structural_validator_histogram: Record<string, number> | string | null
}

interface PortfolioSettingsDbRow {
  project_id: string
  validation_count: number | string | null
  target_lanes: unknown
  /** AQU-1083 effective policy, already COALESCEd project → org → 'true'. */
  count_structural?: string | null
}

/** Endorsement threshold at which a cell counts as validated, per the project's settings (default 1, cap 15). */
function readValidationCounts(settingsRows: PortfolioSettingsDbRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const row of settingsRows) {
    const value = Math.floor(Number(row.validation_count))
    const threshold = Number.isFinite(value) ? Math.min(MAX_VALIDATION_LEVEL, Math.max(1, value)) : 1
    out.set(row.project_id, threshold)
  }
  return out
}

/** Sum of histogram buckets whose endorsement count meets the threshold. */
function validatedFromHistogram(raw: LaneDbRow["validator_histogram"], threshold: number): number {
  let value: unknown = raw
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) } catch { value = null }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0
  let count = 0
  for (const [key, amount] of Object.entries(value as Record<string, unknown>)) {
    const bucket = Number(key)
    const cells = Number(amount)
    if (Number.isInteger(bucket) && bucket >= threshold && Number.isFinite(cells) && cells > 0) count += cells
  }
  return count
}

/**
 * Per-lane rollup for the given org's non-archived projects, keyed by project
 * id. Derive-on-read over `file_section_progress` file-scope rows (one row per
 * file per lane since migration 0055) — a SUM, not new bookkeeping. Lanes are
 * ordered default ('') first, then by tag, for deterministic output.
 */
async function fetchPortfolioLanes(
  env: Env,
  orgIds: number[],
  projectIds?: readonly string[],
): Promise<Map<string, PortfolioLane[]>> {
  const byProject = new Map<string, PortfolioLane[]>()
  if (orgIds.length === 0) return byProject
  const placeholders = orgIds.map(() => "?").join(", ")
  const projectFilter =
    projectIds != null && projectIds.length > 0
      ? ` AND p.id IN (${projectIds.map(() => "?").join(", ")})`
      : ""
  const orgBinds: unknown[] = [...orgIds]
  const projectBinds: unknown[] = projectIds != null && projectIds.length > 0 ? [...projectIds] : []
  const [laneRows, settingsRows] = await Promise.all([
    env.AQUILLA_PG.prepare(
      `SELECT fsp.project_id AS project_id, fsp.target_lang AS target_lang,
              fsp.total_count AS total_count, fsp.filled_count AS filled_count,
              fsp.validator_histogram AS validator_histogram, fsp.updated_at AS updated_at,
              fsp.structural_count AS structural_count,
              fsp.structural_filled_count AS structural_filled_count,
              fsp.structural_validator_histogram AS structural_validator_histogram
         FROM file_section_progress fsp
         JOIN projects p ON p.id = fsp.project_id
        WHERE p.org_id IN (${placeholders}) AND p.archived_at IS NULL AND fsp.scope = 'file'${projectFilter}`,
    ).bind(...orgBinds, ...projectBinds).all<LaneDbRow>(),
    env.AQUILLA_PG.prepare(
      // Driven FROM projects, not from project_settings: a project that has
      // never had a settings row still inherits its org's answer, and inner-
      // joining the settings table hides exactly those projects. The columns
      // this used to read come back null for them, which is what they meant
      // before anyway (default threshold, no registered lanes).
      `SELECT p.id AS project_id,
              ps.validation_count AS validation_count,
              ps.target_lanes AS target_lanes,
              COALESCE(ps.count_structural, os.count_structural, 'true') AS count_structural
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.org_id IN (${placeholders}) AND p.archived_at IS NULL${projectFilter}`,
    ).bind(...orgBinds, ...projectBinds).all<PortfolioSettingsDbRow>(),
  ])
  const thresholds = readValidationCounts(settingsRows.results ?? [])
  // AQU-1083: which projects leave structural cells out. Absent = count them,
  // so a project with no settings row at all keeps today's numbers.
  const excluding = new Set(
    (settingsRows.results ?? [])
      .filter((row) => row.count_structural === "false")
      .map((row) => row.project_id),
  )
  // Accumulate one lane entry per (project, target_lang).
  const acc = new Map<string, Map<string, PortfolioLane>>()
  for (const row of laneRows.results ?? []) {
    const threshold = thresholds.get(row.project_id) ?? 1
    let lanes = acc.get(row.project_id)
    if (!lanes) { lanes = new Map(); acc.set(row.project_id, lanes) }
    const lane = row.target_lang ?? ""
    let entry = lanes.get(lane)
    if (!entry) { entry = { lane, totalCells: 0, filledCells: 0, validatedCells: 0, lastEditAt: null }; lanes.set(lane, entry) }
    // AQU-1083: subtract per file row, then clamp — a partially backfilled
    // project must never contribute a negative number to the lane's sum.
    const drop = excluding.has(row.project_id)
    const structuralTotal = drop ? Number(row.structural_count) || 0 : 0
    const structuralFilled = drop ? Number(row.structural_filled_count) || 0 : 0
    const structuralValidated = drop
      ? validatedFromHistogram(row.structural_validator_histogram, threshold)
      : 0
    entry.totalCells += Math.max(0, (Number(row.total_count) || 0) - structuralTotal)
    entry.filledCells += Math.max(0, (Number(row.filled_count) || 0) - structuralFilled)
    entry.validatedCells += Math.max(
      0,
      validatedFromHistogram(row.validator_histogram, threshold) - structuralValidated,
    )
    const updatedAt = row.updated_at == null ? null : Number(row.updated_at)
    if (updatedAt != null && Number.isFinite(updatedAt)) {
      entry.lastEditAt = entry.lastEditAt == null ? updatedAt : Math.max(entry.lastEditAt, updatedAt)
    }
  }
  // AQU-538: union in REGISTERED lanes that have no progress rows yet — a PM
  // who just added a language must see its 0% chip immediately, not after the
  // first translation lands. The denominator is borrowed from the '' row
  // (source-cell count is lane-independent); no '' row means the project has
  // no progress rows at all and the registered lane stays 0/0.
  for (const row of settingsRows.results ?? []) {
    const registered = readTargetLanes(row.target_lanes)
    if (registered.length === 0) continue
    let lanes = acc.get(row.project_id)
    if (!lanes) {
      lanes = new Map()
      acc.set(row.project_id, lanes)
    }
    const denominator = lanes.get("")?.totalCells ?? 0
    for (const lane of registered) {
      if (lane === "" || lanes.has(lane)) continue
      lanes.set(lane, { lane, totalCells: denominator, filledCells: 0, validatedCells: 0, lastEditAt: null })
    }
  }
  for (const [projectId, lanes] of acc) {
    byProject.set(
      projectId,
      [...lanes.values()].sort((a, b) => (a.lane === b.lane ? 0 : a.lane === "" ? -1 : b.lane === "" ? 1 : a.lane < b.lane ? -1 : 1)),
    )
  }
  return byProject
}

/** Parse the generated target_lanes projection defensively across PG adapters. */
function readTargetLanes(raw: unknown): string[] {
  let value = raw
  if (typeof raw === "string") {
    try { value = JSON.parse(raw) } catch { return [] }
  }
  if (!Array.isArray(value)) return []
  return value.filter((lane): lane is string => typeof lane === "string" && lane !== "")
}

/**
 * AQU-745: per-project visibility predicate for the portfolio rollups. Mirrors
 * the GET /api/v2/projects access predicate (projects.ts) so the org dashboard
 * cannot leak project names the caller can't already open. A regular member
 * sees only projects reached via creator / direct membership / group grant; the
 * org path (blanket visibility) fires only at Maintainer+ (ORG_WIDE_ACCESS_FLOOR),
 * and platform admins bypass entirely. Emits `<isAdmin>, <userId>×4` binds in
 * this exact order — append them to the query in the same order.
 */
const PORTFOLIO_VISIBILITY_PREDICATE = `(
          ?::int = 1
          OR p.created_by = ?
          OR EXISTS (SELECT 1 FROM project_members pm
                      WHERE pm.project_id = p.id AND pm.user_id = ?)
          OR EXISTS (SELECT 1 FROM group_project_grants gpg
                       JOIN group_members gm ON gm.group_id = gpg.group_id
                      WHERE gpg.project_id = p.id AND gm.user_id = ?)
          OR EXISTS (SELECT 1 FROM org_members om
                      WHERE om.org_id = p.org_id AND om.user_id = ?
                        AND om.role_level >= ${ORG_WIDE_ACCESS_FLOOR})
        )`

/**
 * AQU-1083: does this project count structural cells toward progress? Its own
 * answer, else its org's, else yes.
 *
 * MAX() because the surrounding query groups by project and these join 1:1 —
 * the same reason source_language is read that way. STORED generated columns,
 * never the settings blob: parsing ~6 MB of JSON per fan-out row is what timed
 * this dashboard out at 15 seconds in the first place.
 */
const PORTFOLIO_EXCLUDE_STRUCTURAL =
  "COALESCE(MAX(ps.count_structural), MAX(os.count_structural)) = 'false'"

/** `total − structural` when the policy excludes, floored at zero. */
const lessStructural = (total: string, structural: string) =>
  `GREATEST(0, ${total} - CASE WHEN ${PORTFOLIO_EXCLUDE_STRUCTURAL} THEN ${structural} ELSE 0 END)`

/**
 * The per-project cell rollups.
 *
 * ai_drafted follows the policy for the same reason audio does: the client
 * divides it by total_cells, so shrinking the denominator alone would let a
 * scripture project whose headings were machine-drafted read over 100%.
 */
const PORTFOLIO_CELL_COLUMNS = `
            ${lessStructural('COALESCE(SUM(f.cell_count), 0)', 'COALESCE(SUM(f.structural_cell_count), 0)')} AS total_cells,
            ${lessStructural('COALESCE(SUM(f.approved_count), 0)', 'COALESCE(SUM(f.structural_approved_count), 0)')} AS validated_cells,
            ${lessStructural('COALESCE(SUM(f.filled_count), 0)', 'COALESCE(SUM(f.structural_filled_count), 0)')} AS filled_cells,
            ${lessStructural('COALESCE(SUM(f.ai_drafted_count), 0)', 'COALESCE(SUM(f.structural_ai_drafted_count), 0)')} AS ai_drafted_cells,`

/** Shared join tail — the org default now has to reach the rollups too. */
const PORTFOLIO_JOINS = `
       LEFT JOIN files f ON f.project_id = p.id
       LEFT JOIN project_settings ps ON ps.project_id = p.id
       LEFT JOIN org_settings os ON os.org_id = p.org_id
       LEFT JOIN au ON au.project_id = p.id
       LEFT JOIN pu ON pu.project_id = p.id`

/** AQU-1097: planning-unit counts, read from the `pu` CTE above. */
const PORTFOLIO_UNIT_COLUMNS = `
            COALESCE(MAX(pu.units_total), 0)           AS units_total,
            COALESCE(MAX(pu.units_done), 0)            AS units_done,
            COALESCE(MAX(pu.units_overdue), 0)         AS units_overdue`

/**
 * Audio coverage and validation, with structural cells dropped where a project
 * excludes them.
 *
 * `audioPct` divides audio cells by the TEXT total while `audioValidatedPct`
 * divides by the audio total, so leaving audio alone while the text denominator
 * shrank would let a scripture project whose headings were voiced read over
 * 100% covered. Bulk synthesis has no type filter, so those takes genuinely
 * exist.
 *
 * `recorded_ms` never takes the exclusion: it measures work that was actually
 * done rather than progress against a denominator — the same reasoning that
 * keeps word counts out of this setting.
 *
 * Shape matters here. `cell_audio` keys on four columns where `cells` keys on
 * five, so joining them directly fans out per side and per lane; COUNT(DISTINCT)
 * would survive that but SUM would not, silently multiplying recorded_ms. And
 * the structural cell ids are gathered ONCE per excluding project rather than
 * probed per audio row — for every project that counts headings (all of them,
 * until someone opts out) that CTE is empty and the join costs nothing. The
 * previous shape of this query, three correlated subqueries over ~300k rows,
 * is what caused the 15s dashboard timeout; this must not walk back into it.
 */
const portfolioCtes = (orgPredicate: string) => `
     WITH policy AS (
       SELECT p.id AS project_id,
              COALESCE(ps.count_structural, os.count_structural) = 'false' AS excluded,
              -- AQU-490: how many validators a TAKE needs on this project, read
              -- from the generated column rather than the settings blob, which
              -- runs to several megabytes and is what timed this dashboard out
              -- at fifteen seconds once already. The regex guard is not
              -- decoration: the column is TEXT off a jsonb ->>, so a project
              -- that ever stored a non-integer would abort the whole portfolio
              -- query with a cast error rather than just reading wrong.
              GREATEST(1, LEAST(15, COALESCE(
                CASE WHEN ps.validation_count_audio ~ '^[0-9]+$'
                     THEN ps.validation_count_audio::integer END, 1))) AS audio_threshold
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.${orgPredicate}
     ), structural_cells AS (
       SELECT DISTINCT c.project_id, c.file_id, c.cell_id
         FROM cells c
         JOIN policy pol ON pol.project_id = c.project_id AND pol.excluded
        WHERE c.side = 'source' AND c.type IN ('heading', 'paratext')
     ), au_cells AS MATERIALIZED (
       -- AQU-490, level one: one row per CELL, carrying the minimum vote count
       -- across its selected dub takes. Two tracks sound together, so a cell is
       -- only as validated as its least-validated track, and the minimum turns
       -- that into a number the level above can simply compare.
       --
       -- The role filter is what keeps a media project honest. The shared
       -- programme audio is attached, selected, to every cell of an imported
       -- file, so counting it made audio-first-test read as fully recorded with
       -- 52.9 hours of work done — one clip's duration multiplied across 508
       -- cells — when almost nothing had been dubbed.
       -- ONE TAKE PER TRACK. The third of three readers of this definition,
       -- and the last to get the rule: a generated voice left selected beside
       -- a real recording is silent, so nobody can judge it, and counting it
       -- held whole projects' tiles below the board's own number (adversarial
       -- review, 2026-09-22). The recorded-milliseconds sum below deliberately
       -- keeps every selected dub take: that is hours of audio present, not
       -- hours left to judge.
       SELECT a.project_id, a.file_id, a.cell_id,
              MIN(a.validator_count) FILTER (
                WHERE ${takeSoundsOnItsTrackSql('a')}
              ) AS dub_votes,
              SUM(a.duration_ms) AS recorded_ms,
              BOOL_OR(sc.cell_id IS NOT NULL) AS structural
         FROM cell_audio a
         LEFT JOIN structural_cells sc
           ON sc.project_id = a.project_id
          AND sc.file_id = a.file_id
          AND sc.cell_id = a.cell_id
        WHERE a.deleted = 0 AND a.selected = 1 AND a.role = 'dub'
          AND a.project_id IN (SELECT id FROM projects WHERE ${orgPredicate})
        GROUP BY a.project_id, a.file_id, a.cell_id
     ), au AS MATERIALIZED (
       -- Level two: count those cells per project, against the project's own
       -- threshold. A plain join to policy, deliberately -- asking for the
       -- threshold with a correlated subquery per row is the shape that caused
       -- the timeout, and it must not come back through this door.
       SELECT c.project_id,
              COUNT(*) FILTER (WHERE NOT c.structural) AS audio_cells,
              COUNT(*) FILTER (
                WHERE NOT c.structural AND c.dub_votes >= pol.audio_threshold
              ) AS validated_audio_cells,
              COALESCE(SUM(c.recorded_ms), 0) AS recorded_ms
         FROM au_cells c
         JOIN policy pol ON pol.project_id = c.project_id
        GROUP BY c.project_id
     ), pu AS MATERIALIZED (
       ${planUnitCountsSql(`f.project_id IN (SELECT id FROM projects WHERE ${orgPredicate})`)}
     )`

export type PortfolioPageOpts = {
  q: string
  limit: number
  cursor: { id: string; name: string } | null
}

/**
 * One page (or the full set) of visible portfolio rows across `orgIds`,
 * ordered by name. Used by the org / all-orgs project tables so search and
 * infinite scroll do not dump every project to the client.
 */
export async function listOrgPortfolioPage(
  env: Env,
  orgIds: number[],
  viewer: { userId: number; isAdmin: boolean },
  page: PortfolioPageOpts | null,
  now: number = Date.now(),
): Promise<{ projects: OrgPortfolioRow[]; nextCursor: string | null }> {
  const uniqueOrgIds = [...new Set(orgIds)].filter((id) => Number.isInteger(id) && id > 0)
  if (uniqueOrgIds.length === 0) return { projects: [], nextCursor: null }

  const placeholders = uniqueOrgIds.map(() => "?").join(", ")
  const extraWhere: string[] = []
  const extraBinds: unknown[] = []
  if (page?.q) {
    extraWhere.push("strpos(lower(p.name), ?) > 0")
    extraBinds.push(page.q)
  }
  if (page?.cursor) {
    extraWhere.push("(lower(p.name) > ? OR (lower(p.name) = ? AND p.id > ?))")
    extraBinds.push(page.cursor.name.toLowerCase(), page.cursor.name.toLowerCase(), page.cursor.id)
  }
  const extraWhereSql = extraWhere.length > 0 ? ` AND ${extraWhere.join(" AND ")}` : ""
  const orderSql = page ? "LOWER(p.name), p.id" : "p.org_id, LOWER(p.name)"
  const limitSql = page ? " LIMIT ?" : ""
  if (page) extraBinds.push(page.limit + 1)

  // Perf (dashboard 15s timeout fix):
  //  - The AQU-523 language pair reads the STORED generated columns on
  //    project_settings (migration 0054) — never (settings::jsonb)->>'…'
  //    inline: settings blobs run to ~6 MB and the inline extraction
  //    re-parsed that JSON on every file-fan-out row (~100x per project).
  //  - au: the previous 3 correlated cell_audio subqueries re-scanned and
  //    re-sorted cell_audio (~300k rows) per project; one MATERIALIZED
  //    grouped pass replaces them. It joins 1:1 on project_id, so MAX()
  //    collapses the file fan-out without affecting the SUMs (same for the
  //    1:1 project_settings join).
  //  - pu (AQU-1097): plan-unit counts per project, same 1:1 MATERIALIZED
  //    shape as au, bounded to the same org set.
  const rows = await env.AQUILLA_PG.prepare(
    `${portfolioCtes(`org_id IN (${placeholders})`)}
     SELECT p.org_id AS org_id, p.id AS id, p.name AS name, p.deadline_at AS deadline_at,${PORTFOLIO_CELL_COLUMNS}
            MAX(f.last_edit_at)                     AS last_edit_at,
            MAX(ps.source_language)                 AS source_language,
            MAX(ps.target_language)                 AS target_language,
            COALESCE(MAX(au.audio_cells), 0)           AS audio_cells,
            COALESCE(MAX(au.validated_audio_cells), 0) AS validated_audio_cells,
            COALESCE(MAX(au.recorded_ms), 0)           AS recorded_ms,${PORTFOLIO_UNIT_COLUMNS}
       FROM projects p${PORTFOLIO_JOINS}
      WHERE p.org_id IN (${placeholders}) AND p.archived_at IS NULL
        AND ${PORTFOLIO_VISIBILITY_PREDICATE}
        ${extraWhereSql}
      GROUP BY p.org_id, p.id, p.name
      ORDER BY ${orderSql}
      ${limitSql}`,
  ).bind(
    // Org scopes in CTE order: the AQU-1083 policy, the audio scope inside it,
    // the plan-unit counts (preceded by their AoE cutoff date), then the outer
    // WHERE.
    ...uniqueOrgIds, ...uniqueOrgIds,
    aoeTodayIso(now), ...uniqueOrgIds,
    ...uniqueOrgIds,
    viewer.isAdmin ? 1 : 0, viewer.userId, viewer.userId, viewer.userId, viewer.userId,
    ...extraBinds,
  ).all<PortfolioDbRow>()

  const list = rows.results ?? []
  const hasMore = page != null && list.length > page.limit
  const pageRows = hasMore ? list.slice(0, page.limit) : list
  const last = pageRows[pageRows.length - 1]
  const lanesByProject = await fetchPortfolioLanes(
    env,
    uniqueOrgIds,
    page ? pageRows.map((row) => row.id) : undefined,
  )
  return {
    projects: pageRows.map((row) => ({ ...mapPortfolioRow(row, lanesByProject), orgId: row.org_id })),
    nextCursor: hasMore && last ? encodeProjectDirectoryCursor(last.id, last.name) : null,
  }
}

/** Per-project rollup over the org's non-archived projects (derive-on-read, one GROUP BY). */
export async function getOrgPortfolio(
  env: Env,
  orgId: number,
  viewer: { userId: number; isAdmin: boolean },
  now: number = Date.now(),
): Promise<PortfolioRow[]> {
  const { projects } = await listOrgPortfolioPage(env, [orgId], viewer, null, now)
  return projects.map(({ orgId: _orgId, ...project }) => project)
}

/**
 * Soft-deleted files across projects the caller can see in this org.
 * Includes files whose parent project is archived — those still belong in
 * Recently deleted, attributed via projectName. Same visibility predicate as
 * the portfolio so a regular member cannot learn file names from projects
 * they cannot open.
 */
export async function getOrgDeletedFiles(
  env: Env,
  orgId: number,
  viewer: { userId: number; isAdmin: boolean },
): Promise<OrgDeletedFile[]> {
  const rows = await env.AQUILLA_PG.prepare(
    `SELECT f.id AS file_id, f.name AS name, f.project_id AS project_id,
            p.name AS project_name, f.kind AS kind, f.role AS role,
            f.cell_count AS cell_count, f.deleted_at AS deleted_at
       FROM files f
       JOIN projects p ON p.id = f.project_id
      WHERE p.org_id = ?
        AND f.deleted_at IS NOT NULL
        AND ${PORTFOLIO_VISIBILITY_PREDICATE}
      ORDER BY f.deleted_at DESC NULLS LAST, LOWER(f.name)`,
  ).bind(
    orgId,
    viewer.isAdmin ? 1 : 0, viewer.userId, viewer.userId, viewer.userId, viewer.userId,
  ).all<{
    file_id: string
    name: string
    project_id: string
    project_name: string
    kind: string | null
    role: string | null
    cell_count: number | null
    deleted_at: number | string
  }>()
  return (rows.results ?? []).map((r) => ({
    fileId: r.file_id,
    name: r.name,
    projectId: r.project_id,
    projectName: r.project_name,
    fileType: r.kind ?? r.role ?? "codex",
    cellCount: Number(r.cell_count) || 0,
    deletedAt: Number(r.deleted_at),
  }))
}

/** Batched portfolio rollup for all-org dashboard/list views. */
export async function getOrgPortfolios(
  env: Env,
  orgIds: number[],
  viewer: { userId: number; isAdmin: boolean },
  now: number = Date.now(),
): Promise<OrgPortfolioRow[]> {
  const { projects } = await listOrgPortfolioPage(env, orgIds, viewer, null, now)
  return projects
}

export interface ProjectAccessBreakdown {
  projectId: string
  projectName: string
  direct: number | null
  groups: { groupId: number; name: string; roleLevel: number }[]
  org: number | null
  creator: boolean
  resolved: number
}
export interface MemberEffectiveAccess {
  orgRole: number | null
  projects: ProjectAccessBreakdown[]
}

/**
 * Per-project grant-path breakdown for one org member (AD-12 effective-access).
 * Covers the org's non-archived projects where the user has a direct / group /
 * creator path; orgRole is reported once at the top level, but per AQU-435 it
 * only appears as a per-project `org` contribution (and folds into `resolved`)
 * at Maintainer+. Read-only "why does X have access?" surface.
 */
export async function getMemberEffectiveAccess(
  env: Env,
  orgId: number,
  userId: number,
): Promise<MemberEffectiveAccess> {
  const orgRow = await env.AQUILLA_PG.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(orgId, userId).first<{ role_level: number }>()
  const orgRole = orgRow?.role_level ?? null

  const direct = await env.AQUILLA_PG.prepare(
    `SELECT pm.project_id AS project_id, p.name AS name, pm.role_level AS role_level
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.org_id = ? AND pm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; role_level: number }>()

  const groups = await env.AQUILLA_PG.prepare(
    `SELECT gpg.project_id AS project_id, p.name AS name,
            g.id AS group_id, g.name AS group_name, gpg.role_level AS role_level
       FROM group_project_grants gpg
       JOIN groups g         ON g.id = gpg.group_id
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN projects p       ON p.id = gpg.project_id
      WHERE p.org_id = ? AND gm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; group_id: number; group_name: string; role_level: number }>()

  const created = await env.AQUILLA_PG.prepare(
    "SELECT id AS project_id, name FROM projects WHERE org_id = ? AND created_by = ? AND archived_at IS NULL",
  ).bind(orgId, userId).all<{ project_id: string; name: string }>()

  const map = new Map<string, ProjectAccessBreakdown>()
  const ensure = (projectId: string, name: string): ProjectAccessBreakdown => {
    let row = map.get(projectId)
    if (!row) {
      // `org` is filled in per-project below — whether a sub-maintainer org
      // role contributes depends on that project's other paths (AQU-1274).
      row = { projectId, projectName: name, direct: null, groups: [], org: null, creator: false, resolved: 0 }
      map.set(projectId, row)
    }
    return row
  }
  for (const r of direct.results ?? []) ensure(r.project_id, r.name).direct = r.role_level
  for (const r of groups.results ?? []) ensure(r.project_id, r.name).groups.push({ groupId: r.group_id, name: r.group_name, roleLevel: r.role_level })
  for (const r of created.results ?? []) ensure(r.project_id, r.name).creator = true

  for (const row of map.values()) {
    const groupMax = row.groups.reduce((m, g) => Math.max(m, g.roleLevel), 0)
    // Same rule as the resolver (AQU-435 floor + AQU-1274 no-silent-demotion),
    // so the drill-down can never claim a different resolved role than the
    // one enforcement actually uses.
    row.org = orgPathContribution({
      orgLevel: orgRole,
      hasDirectGrant: row.direct != null,
      hasGroupGrant: groupMax > 0,
    })
    row.resolved = Math.max(row.direct ?? 0, groupMax, row.org ?? 0, row.creator ? 700 : 0)
  }

  const projects = Array.from(map.values()).sort((a, b) => a.projectName.localeCompare(b.projectName))
  return { orgRole, projects }
}

export interface ProjectMembershipInOrg {
  projectId: string
  projectName: string
  roleLevel: number
}

/**
 * For "remove from org" confirmation: list projects in this org where the
 * given user has a direct project_members row.
 */
export async function listUserDirectMembershipsInOrg(
  env: Env,
  orgId: number,
  userId: number,
): Promise<ProjectMembershipInOrg[]> {
  const result = await env.AQUILLA_PG.prepare(
    `SELECT pm.project_id AS project_id, p.name AS project_name, pm.role_level AS role_level
     FROM project_members pm
     INNER JOIN projects p ON p.id = pm.project_id
     WHERE p.org_id = ? AND pm.user_id = ?
     ORDER BY p.name ASC`,
  )
    .bind(orgId, userId)
    .all<{ project_id: string; project_name: string; role_level: number }>()

  return (result.results ?? []).map((r) => ({
    projectId: r.project_id,
    projectName: r.project_name,
    roleLevel: r.role_level,
  }))
}

/**
 * Q19 implicit-grant read resolver for org termbase publish/subscribe
 * (terminology Slices 6-7; aquilla-specs 04-features/terminology.md §"Termbase
 * — sharing across projects"). Mirrors canReadSourceCells in
 * services/project-permissions.ts: a subscription row confers an implicit,
 * read-only, termbase-data-only grant on the upstream published project — no
 * project_members write is performed.
 *
 * Returns true iff ALL of:
 *   1. The user is a member of `subscriberProjectId` (any role) — i.e. they
 *      can read the subscriber project in whose context they operate.
 *   2. An active subscription row exists in project_termbase_subscriptions
 *      from `subscriberProjectId` to `termbaseProjectId`.
 *   3. The upstream `termbaseProjectId` is org_published_termbase=true, not
 *      archived, and lives in the SAME org as the subscriber.
 *
 * Direct membership in the upstream is NOT a path here: this resolver is
 * exclusively the derived termbase-data read. A direct upstream member reads
 * the upstream's terminology through the normal project-settings path; the
 * termbase-concepts endpoint is the cross-project implicit grant only.
 *
 * Note: reading concepts from upstream does NOT grant any other rights on
 * upstream — callers must NOT use this resolver as a substitute for
 * resolveProjectRole when operating on upstream's settings, members, etc.
 */
export async function canReadTermbase(
  env: Env,
  user: AuthUser,
  args: { subscriberProjectId: string; termbaseProjectId: string },
): Promise<boolean> {
  if (args.subscriberProjectId === args.termbaseProjectId) return false

  // 1. User must be a member of the subscriber project.
  const subscriberRole = await resolveProjectRole(env, user, args.subscriberProjectId)
  if (!subscriberRole) return false

  // 2. An active subscription row must link subscriber → termbase.
  const sub = await env.AQUILLA_PG.prepare(
    `SELECT 1 AS ok
       FROM project_termbase_subscriptions
      WHERE project_id = ? AND termbase_project_id = ?`,
  )
    .bind(args.subscriberProjectId, args.termbaseProjectId)
    .first<{ ok: number }>()
  if (!sub) return false

  // 3. The upstream must still be published, unarchived, and same-org as the
  //    subscriber. A subscription left dangling after an unpublish (TERM3 #2)
  //    is inert — the grant evaporates the moment publishing stops.
  const subscriber = await env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(args.subscriberProjectId)
    .first<{ org_id: number | null }>()
  if (!subscriber) return false

  const upstream = await env.AQUILLA_PG.prepare(
    "SELECT org_id, org_published_termbase FROM projects WHERE id = ? AND archived_at IS NULL",
  )
    .bind(args.termbaseProjectId)
    .first<{ org_id: number | null; org_published_termbase: number | boolean | null }>()
  if (!upstream) return false

  const isPublished =
    upstream.org_published_termbase === 1 || upstream.org_published_termbase === true
  if (!isPublished) return false
  if (upstream.org_id == null || upstream.org_id !== subscriber.org_id) return false

  return true
}

// ──────────────────────────────────────────────────────────────────────────
// AQU-485: configurable roster + member-progress visibility
//
// Generalizes the AQU-253 exportMinRole pattern to two independent,
// org-scoped read floors stored in the same org_settings JSON blob:
//
//   - rosterViewMinRole:        who can see the member list (+ count)
//   - memberProgressViewMinRole: who can see per-member progress/productivity
//
// Sensitive teams may not want to reveal WHO is on a project (roster) even
// to their own members, and separately may want to hide WHAT each member did
// (progress) even from people who CAN see the roster. The two floors are
// independent — one may be low while the other is high.
//
// Both default to MAINTAINER (600) when unset — the same safe default as
// exportMinRole, and safe for sensitive teams out of the box. The write gate
// for changing either key is OWNER (700), mirroring EXPORT_FLOOR_WRITE_MIN_ROLE
// in org-settings.ts (this is a permission-policy key, not a general setting).
// ──────────────────────────────────────────────────────────────────────────

/** Default floor for both roster and member-progress visibility. */
export const DEFAULT_ROSTER_VIEW_MIN_ROLE = 600 // ROLE.MAINTAINER
export const DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE = 600 // ROLE.MAINTAINER

interface OrgSettingsRowShape {
  settings: string
}

/**
 * Read the raw org_settings JSON blob for a given org, tolerating a missing
 * row (never configured) or malformed JSON (defensive — treat as empty).
 */
async function loadOrgSettingsBlob(env: Env, orgId: number): Promise<Record<string, unknown>> {
  const row = await env.AQUILLA_PG.prepare(
    "SELECT settings FROM org_settings WHERE org_id = ?",
  )
    .bind(orgId)
    .first<OrgSettingsRowShape>()
  if (!row) return {}
  try {
    const parsed = JSON.parse(row.settings)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

/** Extract a valid role-ladder floor from a settings blob key, or the default. */
function extractRoleFloor(
  settings: Record<string, unknown>,
  key: string,
  fallback: number,
): number {
  const raw = settings[key]
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 100 && raw <= 700) return raw
  return fallback
}

/**
 * Resolve the effective roster-view floor for an org (falls back to the
 * MAINTAINER default when the org hasn't configured one).
 */
export async function getRosterViewMinRole(env: Env, orgId: number): Promise<number> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return extractRoleFloor(settings, "rosterViewMinRole", DEFAULT_ROSTER_VIEW_MIN_ROLE)
}

/**
 * Resolve the effective member-progress-view floor for an org (falls back to
 * the MAINTAINER default when the org hasn't configured one).
 */
export async function getMemberProgressViewMinRole(env: Env, orgId: number): Promise<number> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return extractRoleFloor(settings, "memberProgressViewMinRole", DEFAULT_MEMBER_PROGRESS_VIEW_MIN_ROLE)
}

/**
 * True when `callerRoleLevel` meets or exceeds the org's configured roster
 * floor. Pass the floor directly (from getRosterViewMinRole) to avoid a
 * redundant settings fetch when the caller already has it.
 */
export function canViewRoster(callerRoleLevel: number | null, rosterMinRole: number): boolean {
  if (callerRoleLevel == null) return false
  return callerRoleLevel >= rosterMinRole
}

/**
 * True when `callerRoleLevel` meets or exceeds the org's configured
 * member-progress floor.
 *
 * SWARM-TODO(AQU-498): still unconsumed by any auth-worker route — the
 * per-member activity view AQU-498 shipped reads straight from sync-worker
 * (GET /api/v1/projects/:projectId/members/:author/activity, gated by its
 * own resolveMemberProgressFloor in member-progress-floor.ts, since
 * sync-worker doesn't depend on auth-worker). If a future auth-worker route
 * needs the same floor (e.g. a member-progress summary folded into
 * /projects/:projectId/members), it should call this helper rather than
 * re-deriving the comparison.
 */
export function canViewMemberProgress(callerRoleLevel: number | null, progressMinRole: number): boolean {
  if (callerRoleLevel == null) return false
  return callerRoleLevel >= progressMinRole
}

// ──────────────────────────────────────────────────────────────────────────
// AQU-822: configurable termbase-edit floor
//
// Same org_settings permission-policy pattern as the read floors above, but
// this one gates a WRITE: who may manage a project's termbase (add, edit,
// delete, archive concepts). Requested by BGP so translators — Contributors
// (400) — can own terminology on their own projects; other partners keep the
// stricter default, hence an org-level setting rather than a global change.
//
// The default is PROJECT_LEAD (500), NOT the MAINTAINER default the read
// floors use: 500 is the level the client has always shown the termbase
// editor at (TERMBASE_EDIT_LEVEL in src/lib/terminology/glossary-view.ts).
// Before this issue the only server-side gate on terminology was the generic
// project-settings write floor (MAINTAINER 600), so a project_lead saw an
// editor whose saves 403'd. Defaulting to 500 closes that divergence in
// favour of the long-advertised client behavior.
//
// Lowering the floor grants FULL terminology management at that level — no
// draft/suggestion/approval layer (decided 2026-08-07). It does NOT widen any
// other project setting: enforcement is terminology-scoped, see the
// `terminology`-only carve-out in routes/project-settings.ts.
// ──────────────────────────────────────────────────────────────────────────

/** Default floor for managing a project's termbase when the org hasn't set one. */
export const DEFAULT_TERMBASE_EDIT_MIN_ROLE = 500 // ROLE.PROJECT_LEAD

/**
 * Resolve the effective termbase-edit floor for an org (falls back to the
 * PROJECT_LEAD default when the org hasn't configured one, or configured a
 * value outside the role ladder).
 */
/**
 * AQU-1083: the org's default for whether structural cells — chapter headings,
 * section titles, book names — count toward progress.
 *
 * TRUE unless an org says otherwise, which is what every project does today, so
 * nothing moves when this ships. An org that wants its percentages to describe
 * only translated content opts out, and a project may still override it.
 */
export const DEFAULT_COUNT_STRUCTURAL_CELLS = true

export async function getOrgCountStructuralCells(env: Env, orgId: number): Promise<boolean> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  const raw = (settings as Record<string, unknown>)?.countStructuralCells
  return typeof raw === "boolean" ? raw : DEFAULT_COUNT_STRUCTURAL_CELLS
}

export async function getTermbaseEditMinRole(env: Env, orgId: number): Promise<number> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return extractRoleFloor(settings, "termbaseEditMinRole", DEFAULT_TERMBASE_EDIT_MIN_ROLE)
}

/**
 * Resolve the termbase-edit floor that applies to a project, via its org.
 * Projects with no org (personal / not-yet-attached) fall back to the same
 * PROJECT_LEAD default — there is no org policy to consult.
 */
export async function getTermbaseEditMinRoleForProject(
  env: Env,
  projectId: string,
): Promise<number> {
  const project = await env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ org_id: number | null }>()
  if (!project?.org_id) return DEFAULT_TERMBASE_EDIT_MIN_ROLE
  return getTermbaseEditMinRole(env, project.org_id)
}

/**
 * AQU-1083: the org default a project inherits when it has no answer of its
 * own. Null for a project with no org — there is no default to inherit, which
 * the caller renders as the built-in "count them".
 *
 * This rides on the project's SETTINGS response rather than its project
 * record, deliberately: an open editor re-reads its settings on a remote
 * change frame and on window focus, and never re-reads the project record at
 * all. Putting it here is what lets an org-level flip reach a workspace that
 * is already open.
 */
export async function getOrgCountStructuralCellsForProject(
  env: Env,
  projectId: string,
): Promise<boolean | null> {
  const project = await env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ org_id: number | null }>()
  if (!project?.org_id) return null
  return getOrgCountStructuralCells(env, project.org_id)
}

// ──────────────────────────────────────────────────────────────────────────
// AQU-1037: configurable work-assignment floor
//
// Covers assignment.create/reassign/unassign in sync-worker (file, chapter,
// and target-lane-pinned work) plus changeset routing in auth-worker. The
// unset fallback preserves the historical PROJECT_LEAD requirement.
// ──────────────────────────────────────────────────────────────────────────

export const DEFAULT_ASSIGNMENT_MIN_ROLE = 500 // ROLE.PROJECT_LEAD

/** Resolve the minimum project role allowed to assign work in an org. */
export async function getAssignmentMinRole(env: Env, orgId: number): Promise<number> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return extractRoleFloor(settings, "assignmentMinRole", DEFAULT_ASSIGNMENT_MIN_ROLE)
}

/** Resolve assignment authority through a project's org. */
export async function getAssignmentMinRoleForProject(
  env: Env,
  projectId: string,
): Promise<number> {
  const project = await env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ org_id: number | null }>()
  if (!project?.org_id) return DEFAULT_ASSIGNMENT_MIN_ROLE
  return getAssignmentMinRole(env, project.org_id)
}

/**
 * AQU-1308: the assign-work picker IS the roster — you cannot route work to
 * someone you cannot name. `rosterViewMinRole` (AQU-485, default MAINTAINER
 * 600) and `assignmentMinRole` (AQU-1037, default PROJECT_LEAD 500) are
 * independent floors, and the assignment floor ships *below* the roster
 * floor. So out of the box a project lead is authorized to assign work while
 * being forbidden to read the roster the picker needs: the API gate
 * contradicts the UI gate, the members fetch 403s with `rosterHidden`, and
 * every partner org's Assignee dropdown renders empty.
 *
 * Resolve the effective project-roster floor as the LOWER of the two: anyone
 * the org lets assign work may enumerate that project's members. An org that
 * genuinely wants the roster hidden from its leads must raise
 * `assignmentMinRole` to match — one coherent contract instead of two
 * silently-conflicting defaults. Everyone below the assignment floor stays
 * subject to `rosterViewMinRole` exactly as before, so AQU-485's
 * safe-by-default promise for contributors/reviewers/viewers is untouched.
 *
 * Scoped to the per-project roster (the picker's source). The org-wide
 * members list keeps the plain `rosterViewMinRole` gate — assigning work is a
 * project-scoped authority and confers no org-wide roster visibility.
 */
export async function getProjectRosterViewMinRole(env: Env, orgId: number): Promise<number> {
  const [rosterFloor, assignmentFloor] = await Promise.all([
    getRosterViewMinRole(env, orgId),
    getAssignmentMinRole(env, orgId),
  ])
  return Math.min(rosterFloor, assignmentFloor)
}

// ──────────────────────────────────────────────────────────────────────────
// AQU-1086: configurable project-language edit floor
//
// Second write-gating permission-policy key, built on exactly the same
// org_settings plumbing as termbaseEditMinRole above. It answers "who may
// change a project's source/target language and its extra target lanes" —
// Project managers (project_lead 500) running day-to-day projects hit wrong
// or reset languages and today must escalate to a Maintainer for a routine
// correction.
//
// The default is MAINTAINER (600), i.e. today's behaviour byte-for-byte: an
// org opts in by lowering the floor to PROJECT_LEAD. This is the opposite
// choice from the termbase floor (which defaults to 500 to close a
// pre-existing client/server divergence) and matches the read floors —
// other partners deliberately keep languages maintainer-only.
//
// Scope is the language keys ONLY. Lowering this floor must never widen
// write access to AI config, validation, health, timeline, or anything else
// in the settings blob — enforcement is the language-scoped carve-out in
// routes/project-settings.ts, which keys off the CHANGED keys of a write.
// ──────────────────────────────────────────────────────────────────────────

/** Default floor for editing a project's languages when the org hasn't set one. */
export const DEFAULT_LANGUAGE_EDIT_MIN_ROLE = 600 // ROLE.MAINTAINER

/**
 * Resolve the effective language-edit floor for an org (falls back to the
 * MAINTAINER default when the org hasn't configured one, or configured a
 * value outside the role ladder).
 */
export async function getLanguageEditMinRole(env: Env, orgId: number): Promise<number> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return extractRoleFloor(settings, "languageEditMinRole", DEFAULT_LANGUAGE_EDIT_MIN_ROLE)
}

/**
 * Resolve the language-edit floor that applies to a project, via its org.
 * Projects with no org (personal / not-yet-attached) fall back to the same
 * MAINTAINER default — there is no org policy to consult.
 */
export async function getLanguageEditMinRoleForProject(
  env: Env,
  projectId: string,
): Promise<number> {
  const project = await env.AQUILLA_PG.prepare(
    "SELECT org_id FROM projects WHERE id = ?",
  )
    .bind(projectId)
    .first<{ org_id: number | null }>()
  if (!project?.org_id) return DEFAULT_LANGUAGE_EDIT_MIN_ROLE
  return getLanguageEditMinRole(env, project.org_id)
}

// ──────────────────────────────────────────────────────────────────────────
// AQU-1002: configurable comment floors
//
// Two more write floors on the same org_settings pattern. Partners split on
// this one — AQU-999 hardened foreign resolve to CONTRIBUTOR, and some orgs
// then wanted it lower (translators settle the threads on files they
// translate) while others wanted it reserved for maintainers. A floor, not a
// global default, is the only answer that serves both.
//
// Defaults reproduce post-AQU-999 behaviour exactly, so an org that never sets
// them sees no change: COMMENTER (200) to open a thread, CONTRIBUTOR (400) to
// resolve one somebody else opened.
//
// ENFORCEMENT LIVES IN SYNC-WORKER, which owns comments — see
// sync-worker/src/events/comment-floors.ts, which reads the same two keys with
// the same defaults. auth-worker only resolves them here so the floors can
// travel with the project record for client gating (below), exactly as
// termbaseEditMinRole does.
// ──────────────────────────────────────────────────────────────────────────

/** Default floor to open a comment thread when the org hasn't set one. */
export const DEFAULT_COMMENT_CREATE_MIN_ROLE = 200 // ROLE.COMMENTER
/** Default floor to resolve/reopen someone else's thread when unset. */
export const DEFAULT_COMMENT_RESOLVE_MIN_ROLE = 400 // ROLE.CONTRIBUTOR

export interface CommentFloors {
  commentCreateMinRole: number
  commentResolveMinRole: number
}

/** The floors in force for an org, each falling back independently. */
export async function getCommentFloors(env: Env, orgId: number): Promise<CommentFloors> {
  const settings = await loadOrgSettingsBlob(env, orgId)
  return {
    commentCreateMinRole: extractRoleFloor(
      settings,
      "commentCreateMinRole",
      DEFAULT_COMMENT_CREATE_MIN_ROLE,
    ),
    commentResolveMinRole: extractRoleFloor(
      settings,
      "commentResolveMinRole",
      DEFAULT_COMMENT_RESOLVE_MIN_ROLE,
    ),
  }
}

/** Defaults for a project with no org to consult (personal / not attached). */
export const DEFAULT_COMMENT_FLOORS: CommentFloors = {
  commentCreateMinRole: DEFAULT_COMMENT_CREATE_MIN_ROLE,
  commentResolveMinRole: DEFAULT_COMMENT_RESOLVE_MIN_ROLE,
}

