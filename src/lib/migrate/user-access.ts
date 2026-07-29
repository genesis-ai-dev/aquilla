import {
  mapTopLevelAccess,
  planGroupImport,
  type GitLabGroupNode,
  type GitLabSubgroupNode,
  type ResolvedMember,
} from "./groups"
import { projectIdFor } from "./ids"

const PLANNING_USER_ID = 1

export interface GitLabUserMembership {
  source_id: number
  source_type: "Namespace" | "Project"
  access_level: number
}

export interface ExistingAccessTargets {
  orgUuids: Set<string>
  teamUuids: Set<string>
  projectIds: Set<string>
}

export interface CanonicalUserAccessPlan {
  orgMemberships: { orgUuid: string; roleLevel: number }[]
  teamUuids: string[]
  projectMemberships: { projectId: string; roleLevel: number }[]
  conflicts: string[]
  confirmedMembershipCount: number
}

export interface CanonicalUserAccessInput {
  username: string
  topGroups: GitLabGroupNode[]
  subgroups: GitLabSubgroupNode[]
  memberships: GitLabUserMembership[]
  existing: ExistingAccessTargets
}

/** Plan one user's access with the same org/team planner as the full importer.
 * Direct GitLab project memberships are retained as project_members; group-
 * derived project access continues to flow through group_project_grants. */
export function planCanonicalUserAccess(
  input: CanonicalUserAccessInput,
): CanonicalUserAccessPlan {
  const conflicts: string[] = []
  const membershipBySource = new Map<string, GitLabUserMembership>()
  for (const membership of input.memberships) {
    const key = `${membership.source_type}:${membership.source_id}`
    const prior = membershipBySource.get(key)
    if (!prior || membership.access_level > prior.access_level) {
      membershipBySource.set(key, membership)
    }
  }
  const memberships = [...membershipBySource.values()]

  const topById = new Map(input.topGroups.map((group) => [group.id, group]))
  const subgroupById = new Map(input.subgroups.map((group) => [group.id, group]))
  const relevantTopIds = new Set<number>()
  const effectiveGroupAccess = new Map<number, number>()
  const projectRole = new Map<string, number>()

  const addEffectiveGroup = (groupId: number, accessLevel: number): void => {
    effectiveGroupAccess.set(
      groupId,
      Math.max(effectiveGroupAccess.get(groupId) ?? 0, accessLevel),
    )
  }

  for (const membership of memberships) {
    if (membership.source_type === "Project") {
      const projectId = projectIdFor(String(membership.source_id), "gitlab")
      if (!input.existing.projectIds.has(projectId)) {
        conflicts.push(`GitLab project ${membership.source_id} is not present in Aquilla`)
        continue
      }
      projectRole.set(
        projectId,
        Math.max(
          projectRole.get(projectId) ?? 0,
          mapTopLevelAccess(membership.access_level),
        ),
      )
      continue
    }

    const top = topById.get(membership.source_id)
    const subgroup = subgroupById.get(membership.source_id)
    if (!top && !subgroup) {
      conflicts.push(`GitLab group ${membership.source_id} is outside the imported topology`)
      continue
    }
    const topLevelId = top?.id ?? subgroup!.topLevelId
    relevantTopIds.add(topLevelId)
    addEffectiveGroup(membership.source_id, membership.access_level)

    // GitLab's user-memberships endpoint intentionally returns direct
    // memberships only. Reconstruct the effective descendants before calling
    // the same group planner used by the full importer's `/members/all`
    // snapshot, otherwise a parent-group member loses inherited Aquilla teams.
    if (top) {
      for (const candidate of input.subgroups) {
        if (candidate.topLevelId === top.id) {
          addEffectiveGroup(candidate.id, membership.access_level)
        }
      }
    } else {
      for (const candidate of input.subgroups) {
        if (
          candidate.topLevelId === subgroup!.topLevelId &&
          candidate.full_path.startsWith(`${subgroup!.full_path}/`)
        ) {
          addEffectiveGroup(candidate.id, membership.access_level)
        }
      }
    }
  }

  const membersByGroupId = new Map<number, ResolvedMember[]>(
    [...effectiveGroupAccess].map(([groupId, accessLevel]) => [
      groupId,
      [{
        userId: PLANNING_USER_ID,
        username: input.username,
        access_level: accessLevel,
      }],
    ]),
  )

  const relevantTops = input.topGroups.filter((group) => relevantTopIds.has(group.id))
  const relevantSubgroups = input.subgroups.filter((group) =>
    relevantTopIds.has(group.topLevelId),
  )
  const groupPlan = planGroupImport({
    topGroups: relevantTops,
    subgroups: relevantSubgroups,
    membersByGroupId,
    existing: {
      orgUuids: input.existing.orgUuids,
      teamUuids: input.existing.teamUuids,
    },
  })

  conflicts.push(...groupPlan.conflicts.map((conflict) => conflict.detail))
  for (const org of groupPlan.orgs) {
    conflicts.push(`Aquilla organization ${org.legacyUuid} has not been imported`)
  }
  for (const team of groupPlan.teams) {
    conflicts.push(`Aquilla group ${team.legacyUuid} has not been imported`)
  }

  const orgRole = new Map<string, number>()
  for (const member of groupPlan.orgMembers) {
    if (member.userId !== PLANNING_USER_ID) continue
    orgRole.set(
      member.orgUuid,
      Math.max(orgRole.get(member.orgUuid) ?? 0, member.roleLevel),
    )
  }

  return {
    orgMemberships: [...orgRole]
      .map(([orgUuid, roleLevel]) => ({ orgUuid, roleLevel }))
      .sort((a, b) => a.orgUuid.localeCompare(b.orgUuid)),
    teamUuids: [...new Set(
      groupPlan.teamMembers
        .filter((member) => member.userId === PLANNING_USER_ID)
        .map((member) => member.teamUuid),
    )].sort(),
    projectMemberships: [...projectRole]
      .map(([projectId, roleLevel]) => ({ projectId, roleLevel }))
      .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    conflicts,
    confirmedMembershipCount: memberships.length,
  }
}
