// Pure planning for the GitLab group tree → Aquilla org/team/member import.
//
// Mapping (locked with the operator):
//   top-level group        → organizations            (legacy_uuid = orgLegacyUuidFor(gitlabId))
//   subgroup (any depth)   → groups ("team")          flattened; legacy_uuid = teamLegacyUuidFor(gitlabId)
//   any member in the tree → org_members
//   direct subgroup member → group_members
//
// Permissions — the decisive rule:
//   ORG-LEVEL authority comes from TOP-LEVEL membership only. A direct top-level
//   member is mapped from their GitLab access level (Owner→700 … Guest→100). A
//   user who appears ONLY in subgroups still becomes an org member (required
//   before they can be a group member) but is CAPPED AT CONTRIBUTOR (400),
//   regardless of being a subgroup Owner — so a subgroup owner can never inherit
//   org-wide authority. Their subgroup-scoped elevation flows through the
//   team → group_project_grants path (handled in the project pass), not here.
//
// Idempotency: orgs/teams are deduped by deterministic legacy_uuid; rows already
// present (passed in `existing`) are not re-emitted as creates, but their member
// rows are still planned (INSERT OR IGNORE makes that a no-op on re-run).
//
// Members must arrive already resolved to an aquilla user id (GitLab usernames
// == Frontier usernames, matched in the applier). Unresolved members (userId
// null) never become rows — they are surfaced as conflicts.

import { orgLegacyUuidFor, teamLegacyUuidFor } from "./ids"

/** GitLab member access levels (REST `access_level`). */
export const GITLAB_ACCESS = {
  GUEST: 10,
  REPORTER: 20,
  DEVELOPER: 30,
  MAINTAINER: 40,
  OWNER: 50,
} as const

/** Aquilla role levels (mirror of auth-worker ROLE_NAMES). */
export const ROLE = {
  VIEWER: 100,
  COMMENTER: 200,
  REVIEWER: 300,
  CONTRIBUTOR: 400,
  PROJECT_LEAD: 500,
  MAINTAINER: 600,
  OWNER: 700,
} as const

/** Org role for a DIRECT top-level member, from their GitLab access level. */
export function mapTopLevelAccess(access: number): number {
  if (access >= GITLAB_ACCESS.OWNER) return ROLE.OWNER // 50 → 700
  if (access >= GITLAB_ACCESS.MAINTAINER) return ROLE.MAINTAINER // 40 → 600
  if (access >= GITLAB_ACCESS.DEVELOPER) return ROLE.CONTRIBUTOR // 30 → 400
  if (access >= GITLAB_ACCESS.REPORTER) return ROLE.REVIEWER // 20 → 300
  return ROLE.VIEWER // 10 (and below) → 100
}

/** Org role cap for users present ONLY in subgroups (never above contributor). */
export const SUBGROUP_ONLY_ROLE = ROLE.CONTRIBUTOR // 400

export interface GitLabGroupNode {
  id: number
  name: string
  full_path: string
}

/** A flattened descendant subgroup, tagged with the top-level group it lives under. */
export interface GitLabSubgroupNode extends GitLabGroupNode {
  topLevelId: number
}

/** A group membership row, already resolved to an aquilla user id (or null if
 *  the GitLab user has no matching aquilla account). */
export interface ResolvedMember {
  userId: number | null
  username: string
  access_level: number
}

export interface ExistingTargets {
  /** legacy_uuids of organizations already in aquilla-db. */
  orgUuids: Set<string>
  /** legacy_uuids of groups already in aquilla-db. */
  teamUuids: Set<string>
}

export interface GroupImportInput {
  topGroups: GitLabGroupNode[]
  /** Flattened descendants across all top groups (each tagged with topLevelId). */
  subgroups: GitLabSubgroupNode[]
  /** Direct members per group id — for both top groups AND subgroups. */
  membersByGroupId: Map<number, ResolvedMember[]>
  existing: ExistingTargets
}

export interface OrgCreateRow {
  legacyUuid: string
  gitlabId: number
  name: string
  ownerUserId: number
}
export interface OrgMemberRow {
  orgUuid: string
  userId: number
  roleLevel: number
}
export interface TeamCreateRow {
  legacyUuid: string
  orgUuid: string
  gitlabId: number
  name: string
  createdBy: number
}
export interface TeamMemberRow {
  teamUuid: string
  userId: number
}
export interface GroupConflict {
  kind: "no-owner" | "unresolved-user"
  detail: string
}

export interface GroupImportPlan {
  /** Orgs to INSERT (new legacy_uuids only). */
  orgs: OrgCreateRow[]
  /** org_members to upsert (covers new + existing orgs). */
  orgMembers: OrgMemberRow[]
  /** Teams (groups) to INSERT (new legacy_uuids only). */
  teams: TeamCreateRow[]
  /** group_members to upsert. */
  teamMembers: TeamMemberRow[]
  conflicts: GroupConflict[]
}

const resolved = (m: ResolvedMember): m is ResolvedMember & { userId: number } =>
  typeof m.userId === "number" && m.userId > 0

/**
 * Pick the org owner among a top group's resolved members: a GitLab Owner
 * (access 50) wins; ties and owner-absent fall back to highest access, then
 * lowest aquilla user id — deterministic so re-runs agree. Returns null when the
 * top group has no resolvable members at all (caller surfaces a conflict).
 */
function pickOwner(members: ResolvedMember[]): number | null {
  const candidates = members.filter(resolved)
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.access_level - a.access_level || a.userId - b.userId)
  return candidates[0].userId
}

export function planGroupImport(input: GroupImportInput): GroupImportPlan {
  const plan: GroupImportPlan = {
    orgs: [],
    orgMembers: [],
    teams: [],
    teamMembers: [],
    conflicts: [],
  }

  for (const top of input.topGroups) {
    const orgUuid = orgLegacyUuidFor(top.id)
    const topMembers = input.membersByGroupId.get(top.id) ?? []
    const subs = input.subgroups.filter((s) => s.topLevelId === top.id)

    const ownerUserId = pickOwner(topMembers)
    if (ownerUserId === null) {
      plan.conflicts.push({
        kind: "no-owner",
        detail: `top-level group "${top.full_path}" (${top.id}) has no resolvable members — org skipped`,
      })
      continue
    }

    if (!input.existing.orgUuids.has(orgUuid)) {
      plan.orgs.push({ legacyUuid: orgUuid, gitlabId: top.id, name: top.name, ownerUserId })
    }

    // org_members: top-level members mapped from access; subgroup-only members
    // capped at contributor. A user present at top level keeps the top role.
    const orgRole = new Map<number, number>()
    for (const m of topMembers) {
      if (!resolved(m)) {
        plan.conflicts.push({
          kind: "unresolved-user",
          detail: `@${m.username} in "${top.full_path}" has no aquilla account — skipped`,
        })
        continue
      }
      const role = mapTopLevelAccess(m.access_level)
      orgRole.set(m.userId, Math.max(orgRole.get(m.userId) ?? 0, role))
    }
    for (const sub of subs) {
      for (const m of input.membersByGroupId.get(sub.id) ?? []) {
        if (!resolved(m)) {
          plan.conflicts.push({
            kind: "unresolved-user",
            detail: `@${m.username} in "${sub.full_path}" has no aquilla account — skipped`,
          })
          continue
        }
        if (!orgRole.has(m.userId)) orgRole.set(m.userId, SUBGROUP_ONLY_ROLE)
      }
    }
    for (const [userId, roleLevel] of orgRole) {
      plan.orgMembers.push({ orgUuid, userId, roleLevel })
    }

    // teams: one per subgroup, flattened. name = full_path for UNIQUE(org_id,name).
    for (const sub of subs) {
      const teamUuid = teamLegacyUuidFor(sub.id)
      if (!input.existing.teamUuids.has(teamUuid)) {
        plan.teams.push({
          legacyUuid: teamUuid,
          orgUuid,
          gitlabId: sub.id,
          name: sub.full_path,
          createdBy: ownerUserId,
        })
      }
      for (const m of input.membersByGroupId.get(sub.id) ?? []) {
        if (resolved(m)) plan.teamMembers.push({ teamUuid, userId: m.userId })
      }
    }
  }

  return plan
}
