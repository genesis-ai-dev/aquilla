// Organization-permission helpers for the codex-web identity/project backend.

import type { Env, AuthUser } from "../types"

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
  const existing = await env.AQUILLA_DB.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ? ORDER BY id ASC LIMIT 1",
  )
    .bind(user.id)
    .first<{ id: number; name: string | null }>()

  if (existing) {
    return { id: existing.id, name: existing.name, role: 700 }
  }

  const name = `${user.username}'s workspace`
  const inserted = await env.AQUILLA_DB.prepare(
    `INSERT INTO organizations (name, owner_user_id)
     VALUES (?, ?) RETURNING id`,
  )
    .bind(name, user.id)
    .first<{ id: number }>()
  if (!inserted) throw new Error("failed to insert organization row")

  await env.AQUILLA_DB.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by)
     VALUES (?, ?, 700, ?)
     ON CONFLICT(org_id, user_id) DO NOTHING`,
  )
    .bind(inserted.id, user.id, user.id)
    .run()

  return { id: inserted.id, name, role: 700 }
}

export async function createOrgForUser(env: Env, user: AuthUser, name: string): Promise<{ id: number; name: string }> {
  const inserted = await env.AQUILLA_DB.prepare(
    "INSERT INTO organizations (name, owner_user_id) VALUES (?, ?) RETURNING id",
  ).bind(name, user.id).first<{ id: number }>()
  if (!inserted) throw new Error("failed to insert organization")
  await env.AQUILLA_DB.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?) ON CONFLICT(org_id, user_id) DO NOTHING",
  ).bind(inserted.id, user.id, user.id).run()
  return { id: inserted.id, name }
}

export async function renameOrg(env: Env, orgId: number, name: string): Promise<void> {
  await env.AQUILLA_DB.prepare(
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

  const owned = await env.AQUILLA_DB.prepare(
    "SELECT id, name FROM organizations WHERE owner_user_id = ?",
  ).bind(user.id).all<{ id: number; name: string | null }>()
  for (const o of owned.results ?? []) {
    byId.set(o.id, { id: o.id, name: o.name, role: 700 })
  }

  const memberships = await env.AQUILLA_DB.prepare(
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

/** Return the role_level of (org_id, user_id) or null if no row. */
export async function getOrgMemberRole(
  env: Env,
  orgId: number,
  userId: number,
): Promise<number | null> {
  const row = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  )
    .bind(orgId, userId)
    .first<{ role_level: number }>()
  return row?.role_level ?? null
}

export interface OrgMemberWithUser {
  userId: number
  username: string
  roleLevel: number
  /** ISO timestamp of last project-context activity, or NULL. */
  lastActiveAt: string | null
}

/** All org members joined to users for display. */
export async function listOrgMembersWithUsers(
  env: Env,
  orgId: number,
): Promise<OrgMemberWithUser[]> {
  const result = await env.AQUILLA_DB.prepare(
    `SELECT om.user_id AS user_id, u.username AS username,
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
      role_level: number
      last_active_at: string | null
    }>()

  return (result.results ?? []).map((r) => ({
    userId: r.user_id,
    username: r.username,
    roleLevel: r.role_level,
    lastActiveAt: r.last_active_at,
  }))
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
  try {
    await env.AQUILLA_DB.prepare(
      `UPDATE org_members
          SET last_active_at = CURRENT_TIMESTAMP
        WHERE org_id = ? AND user_id = ?
          AND (last_active_at IS NULL
               OR last_active_at < datetime('now', '-5 minutes'))`,
    )
      .bind(orgId, userId)
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
}

/** Unredeemed, unexpired project_invites for projects in this org. */
export async function listPendingInvitesInOrg(
  env: Env,
  orgId: number,
): Promise<PendingOrgInvite[]> {
  const result = await env.AQUILLA_DB.prepare(
    `SELECT pi.token AS token,
            pi.project_id AS project_id,
            p.name AS project_name,
            pi.role_level AS role_level,
            pi.created_by AS created_by_user_id,
            cu.username AS created_by_username,
            pi.created_at AS created_at,
            pi.expires_at AS expires_at
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
  }))
}

export interface EffectiveMember {
  userId: number
  username: string
  roleLevel: number
  /** Path that produced the user's max-wins role (AD-12). */
  source: "override" | "group" | "org" | "creator"
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
  const direct = await env.AQUILLA_DB.prepare(
    `SELECT pm.user_id AS user_id, u.username AS username, pm.role_level AS role_level
     FROM project_members pm
     INNER JOIN users u ON u.id = pm.user_id
     WHERE pm.project_id = ?`,
  )
    .bind(projectId)
    .all<{ user_id: number; username: string; role_level: number }>()

  const merged = new Map<number, EffectiveMember>()

  const consider = (
    candidate: EffectiveMember,
    priority: number,
  ): void => {
    const existing = merged.get(candidate.userId)
    if (!existing) {
      merged.set(candidate.userId, candidate)
      return
    }
    if (candidate.roleLevel > existing.roleLevel) {
      merged.set(candidate.userId, candidate)
      return
    }
    // Tie on roleLevel — prefer the higher-priority source.
    if (candidate.roleLevel === existing.roleLevel) {
      const existingPriority = SOURCE_PRIORITY[existing.source]
      if (priority > existingPriority) {
        merged.set(candidate.userId, candidate)
      }
    }
  }

  for (const r of direct.results ?? []) {
    consider(
      {
        userId: r.user_id,
        username: r.username,
        roleLevel: r.role_level,
        source: "override",
      },
      SOURCE_PRIORITY.override,
    )
  }

  // AD-12: surface every user who reaches the project via a group attached
  // to it. MAX-aggregate across group memberships gives the user's best
  // group-level grant; the per-group breakdown is a Pass C concern.
  const groupRows = await env.AQUILLA_DB.prepare(
    `SELECT gm.user_id AS user_id,
            u.username AS username,
            MAX(gpg.role_level) AS role_level
       FROM group_project_grants gpg
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN users u          ON u.id = gm.user_id
      WHERE gpg.project_id = ?
      GROUP BY gm.user_id, u.username`,
  )
    .bind(projectId)
    .all<{ user_id: number; username: string; role_level: number | null }>()

  for (const r of groupRows.results ?? []) {
    if (r.role_level == null) continue
    consider(
      {
        userId: r.user_id,
        username: r.username,
        roleLevel: r.role_level,
        source: "group",
      },
      SOURCE_PRIORITY.group,
    )
  }

  if (orgId != null) {
    const orgMembers = await env.AQUILLA_DB.prepare(
      `SELECT om.user_id AS user_id, u.username AS username, om.role_level AS role_level
       FROM org_members om
       INNER JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ?`,
    )
      .bind(orgId)
      .all<{ user_id: number; username: string; role_level: number }>()

    for (const r of orgMembers.results ?? []) {
      consider(
        {
          userId: r.user_id,
          username: r.username,
          roleLevel: r.role_level,
          source: "org",
        },
        SOURCE_PRIORITY.org,
      )
    }
  }

  const creatorRow = await env.AQUILLA_DB.prepare(
    "SELECT id, username FROM users WHERE id = ?",
  )
    .bind(createdBy)
    .first<{ id: number; username: string }>()
  if (creatorRow) {
    consider(
      {
        userId: creatorRow.id,
        username: creatorRow.username,
        roleLevel: 700,
        source: "creator",
      },
      SOURCE_PRIORITY.creator,
    )
  }

  return Array.from(merged.values()).sort(
    (a, b) => b.roleLevel - a.roleLevel || a.username.localeCompare(b.username),
  )
}

const SOURCE_PRIORITY: Record<EffectiveMember["source"], number> = {
  override: 4,
  group: 3,
  org: 2,
  creator: 1,
}

export interface OrgGroupSummary {
  id: number
  name: string
  memberCount: number
  projectCount: number
  viewerIsMember: boolean
}

/** Groups in an org, with counts and whether the viewer is a member. */
export async function listOrgGroups(
  env: Env,
  orgId: number,
  viewerId: number,
): Promise<OrgGroupSummary[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT g.id AS id, g.name AS name,
            (SELECT COUNT(*) FROM group_members gm WHERE gm.group_id = g.id) AS member_count,
            (SELECT COUNT(*) FROM group_project_grants gpg WHERE gpg.group_id = g.id) AS project_count,
            EXISTS (SELECT 1 FROM group_members gm2 WHERE gm2.group_id = g.id AND gm2.user_id = ?) AS viewer_is_member
       FROM groups g
      WHERE g.org_id = ?
      ORDER BY g.name COLLATE NOCASE`,
  )
    .bind(viewerId, orgId)
    .all<{ id: number; name: string; member_count: number; project_count: number; viewer_is_member: number }>()

  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    memberCount: r.member_count,
    projectCount: r.project_count,
    viewerIsMember: r.viewer_is_member === 1,
  }))
}

export interface OrgGroupDetail {
  id: number
  name: string
  members: Array<{ userId: number; username: string; roleLevel: number | null }>
  projects: Array<{ id: string; name: string; grantedRoleLevel: number }>
}

/** Members + attached projects of a single group. Null if not in this org. */
export async function getOrgGroupDetail(
  env: Env,
  orgId: number,
  groupId: number,
): Promise<OrgGroupDetail | null> {
  const group = await env.AQUILLA_DB.prepare(
    "SELECT id, name FROM groups WHERE id = ? AND org_id = ?",
  )
    .bind(groupId, orgId)
    .first<{ id: number; name: string }>()
  if (!group) return null

  const members = await env.AQUILLA_DB.prepare(
    `SELECT gm.user_id AS user_id, u.username AS username, om.role_level AS role_level
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN org_members om ON om.org_id = ? AND om.user_id = gm.user_id
      WHERE gm.group_id = ?
      ORDER BY u.username COLLATE NOCASE`,
  )
    .bind(orgId, groupId)
    .all<{ user_id: number; username: string; role_level: number | null }>()

  const projects = await env.AQUILLA_DB.prepare(
    `SELECT gpg.project_id AS id, p.name AS name, gpg.role_level AS granted
       FROM group_project_grants gpg
       JOIN projects p ON p.id = gpg.project_id
      WHERE gpg.group_id = ? AND p.org_id = ?
      ORDER BY p.name COLLATE NOCASE`,
  )
    .bind(groupId, orgId)
    .all<{ id: string; name: string; granted: number }>()

  return {
    id: group.id,
    name: group.name,
    members: (members.results ?? []).map((m) => ({ userId: m.user_id, username: m.username, roleLevel: m.role_level })),
    projects: (projects.results ?? []).map((p) => ({ id: p.id, name: p.name, grantedRoleLevel: p.granted })),
  }
}

/** True if a group with this id exists in this org. */
export async function groupExistsInOrg(env: Env, orgId: number, groupId: number): Promise<boolean> {
  const row = await env.AQUILLA_DB.prepare(
    "SELECT 1 AS ok FROM groups WHERE id = ? AND org_id = ?",
  ).bind(groupId, orgId).first<{ ok: number }>()
  return row != null
}

export interface GroupRow { id: number; name: string; description: string | null }

/** Create a group. Returns null if the name already exists in the org. */
export async function createGroup(env: Env, orgId: number, name: string, description: string | null, createdBy: number): Promise<GroupRow | null> {
  const existing = await env.AQUILLA_DB.prepare(
    "SELECT id FROM groups WHERE org_id = ? AND name = ?",
  ).bind(orgId, name).first<{ id: number }>()
  if (existing) return null
  const row = await env.AQUILLA_DB.prepare(
    "INSERT INTO groups (org_id, name, description, created_by) VALUES (?, ?, ?, ?) RETURNING id, name, description",
  ).bind(orgId, name, description, createdBy).first<GroupRow>()
  return row
}

/** Update name/description. Returns null on duplicate-name conflict. */
export async function updateGroup(env: Env, orgId: number, groupId: number, name: string | undefined, description: string | undefined): Promise<GroupRow | null> {
  if (name != null) {
    const clash = await env.AQUILLA_DB.prepare(
      "SELECT id FROM groups WHERE org_id = ? AND name = ? AND id != ?",
    ).bind(orgId, name, groupId).first<{ id: number }>()
    if (clash) return null
  }
  await env.AQUILLA_DB.prepare(
    `UPDATE groups SET
       name = COALESCE(?, name),
       description = COALESCE(?, description),
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND org_id = ?`,
  ).bind(name ?? null, description ?? null, groupId, orgId).run()
  return env.AQUILLA_DB.prepare(
    "SELECT id, name, description FROM groups WHERE id = ?",
  ).bind(groupId).first<GroupRow>()
}

/** Delete a group (FK cascades members + grants). */
export async function deleteGroup(env: Env, orgId: number, groupId: number): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM groups WHERE id = ? AND org_id = ?").bind(groupId, orgId).run()
}

/** Add an org member to a group. Returns "not-org-member" if the target isn't in the org. */
export async function addGroupMember(env: Env, orgId: number, groupId: number, targetUserId: number, addedBy: number): Promise<"ok" | "not-org-member"> {
  const orgRole = await getOrgMemberRole(env, orgId, targetUserId)
  if (orgRole == null) return "not-org-member"
  await env.AQUILLA_DB.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (?, ?, ?) ON CONFLICT(group_id, user_id) DO NOTHING",
  ).bind(groupId, targetUserId, addedBy).run()
  return "ok"
}

export async function removeGroupMember(env: Env, groupId: number, userId: number): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").bind(groupId, userId).run()
}

/** Attach (or re-grant) a project to a group. Returns "cross-org" if the project isn't in this org. */
export async function attachGroupProject(env: Env, orgId: number, groupId: number, projectId: string, roleLevel: number, grantedBy: number): Promise<"ok" | "cross-org" | "no-project"> {
  const proj = await env.AQUILLA_DB.prepare("SELECT org_id FROM projects WHERE id = ?").bind(projectId).first<{ org_id: number | null }>()
  if (!proj) return "no-project"
  if (proj.org_id !== orgId) return "cross-org"
  await env.AQUILLA_DB.prepare(
    `INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id, project_id) DO UPDATE SET role_level = excluded.role_level, granted_by = excluded.granted_by`,
  ).bind(groupId, projectId, roleLevel, grantedBy).run()
  return "ok"
}

/** Change the granted role for an existing attachment. Returns false if no attachment. */
export async function updateGroupProjectRole(env: Env, groupId: number, projectId: string, roleLevel: number): Promise<boolean> {
  const existing = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM group_project_grants WHERE group_id = ? AND project_id = ?",
  ).bind(groupId, projectId).first()
  if (!existing) return false
  await env.AQUILLA_DB.prepare(
    "UPDATE group_project_grants SET role_level = ? WHERE group_id = ? AND project_id = ?",
  ).bind(roleLevel, groupId, projectId).run()
  return true
}

export async function detachGroupProject(env: Env, groupId: number, projectId: string): Promise<void> {
  await env.AQUILLA_DB.prepare("DELETE FROM group_project_grants WHERE group_id = ? AND project_id = ?").bind(groupId, projectId).run()
}

export interface PortfolioRow { id: string; name: string; totalCells: number; validatedCells: number; filledCells: number; lastEditAt: number | null; audioCells: number; recordedMs: number; deadlineAt: string | null }

/** Per-project rollup over the org's non-archived projects (derive-on-read, one GROUP BY). */
export async function getOrgPortfolio(env: Env, orgId: number): Promise<PortfolioRow[]> {
  const rows = await env.AQUILLA_DB.prepare(
    `SELECT p.id AS id, p.name AS name, p.deadline_at AS deadline_at,
            COALESCE(SUM(f.cell_count), 0)     AS total_cells,
            COALESCE(SUM(f.approved_count), 0) AS validated_cells,
            COALESCE(SUM(f.filled_count), 0)   AS filled_cells,
            MAX(f.last_edit_at)                AS last_edit_at,
            (SELECT COUNT(DISTINCT ca.cell_id) FROM cell_audio ca
              WHERE ca.project_id = p.id AND ca.deleted = 0)                    AS audio_cells,
            (SELECT COALESCE(SUM(ca.duration_ms), 0) FROM cell_audio ca
              WHERE ca.project_id = p.id AND ca.deleted = 0 AND ca.selected = 1) AS recorded_ms
       FROM projects p
       LEFT JOIN files f ON f.project_id = p.id
      WHERE p.org_id = ? AND p.archived_at IS NULL
      GROUP BY p.id, p.name
      ORDER BY p.name COLLATE NOCASE`,
  ).bind(orgId).all<{ id: string; name: string; deadline_at: string | null; total_cells: number; validated_cells: number; filled_cells: number; last_edit_at: number | null; audio_cells: number; recorded_ms: number }>()
  return (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    totalCells: r.total_cells,
    validatedCells: r.validated_cells,
    filledCells: r.filled_cells,
    lastEditAt: r.last_edit_at,
    audioCells: r.audio_cells,
    recordedMs: r.recorded_ms,
    deadlineAt: r.deadline_at,
  }))
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
 * creator path; the org-wide baseline (orgRole) is reported once and folded
 * into each project's resolved max. Read-only "why does X have access?" surface.
 */
export async function getMemberEffectiveAccess(
  env: Env,
  orgId: number,
  userId: number,
): Promise<MemberEffectiveAccess> {
  const orgRow = await env.AQUILLA_DB.prepare(
    "SELECT role_level FROM org_members WHERE org_id = ? AND user_id = ?",
  ).bind(orgId, userId).first<{ role_level: number }>()
  const orgRole = orgRow?.role_level ?? null

  const direct = await env.AQUILLA_DB.prepare(
    `SELECT pm.project_id AS project_id, p.name AS name, pm.role_level AS role_level
       FROM project_members pm JOIN projects p ON p.id = pm.project_id
      WHERE p.org_id = ? AND pm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; role_level: number }>()

  const groups = await env.AQUILLA_DB.prepare(
    `SELECT gpg.project_id AS project_id, p.name AS name,
            g.id AS group_id, g.name AS group_name, gpg.role_level AS role_level
       FROM group_project_grants gpg
       JOIN groups g         ON g.id = gpg.group_id
       JOIN group_members gm ON gm.group_id = gpg.group_id
       JOIN projects p       ON p.id = gpg.project_id
      WHERE p.org_id = ? AND gm.user_id = ? AND p.archived_at IS NULL`,
  ).bind(orgId, userId).all<{ project_id: string; name: string; group_id: number; group_name: string; role_level: number }>()

  const created = await env.AQUILLA_DB.prepare(
    "SELECT id AS project_id, name FROM projects WHERE org_id = ? AND created_by = ? AND archived_at IS NULL",
  ).bind(orgId, userId).all<{ project_id: string; name: string }>()

  const map = new Map<string, ProjectAccessBreakdown>()
  const ensure = (projectId: string, name: string): ProjectAccessBreakdown => {
    let row = map.get(projectId)
    if (!row) {
      row = { projectId, projectName: name, direct: null, groups: [], org: orgRole, creator: false, resolved: 0 }
      map.set(projectId, row)
    }
    return row
  }
  for (const r of direct.results ?? []) ensure(r.project_id, r.name).direct = r.role_level
  for (const r of groups.results ?? []) ensure(r.project_id, r.name).groups.push({ groupId: r.group_id, name: r.group_name, roleLevel: r.role_level })
  for (const r of created.results ?? []) ensure(r.project_id, r.name).creator = true

  for (const row of map.values()) {
    const groupMax = row.groups.reduce((m, g) => Math.max(m, g.roleLevel), 0)
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
  const result = await env.AQUILLA_DB.prepare(
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
