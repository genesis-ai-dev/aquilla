// FRO-326: org-level "External collaborators" — users who reach this org's
// projects only via project-level grants (invite-link redeem, bulk-add,
// group) without being org members.
//
// Deliberately DERIVED, never materialized: an org_members row is an
// org-wide grant in the AD-12 resolver, so a stored "external" membership
// would need special-casing in every resolver/list join (privilege-escalation
// risk) and a lifecycle of its own (who deletes it when the last grant goes?).
// Deriving from the members matrix the page already fetches is self-healing —
// revoke the last grant and the person vanishes from the list.

import type { ProjectMember } from "@/lib/frontier/members"

export interface ExternalGrant {
  projectId: string
  projectName: string
  roleLevel: number
  roleName: string
  source: ProjectMember["role"]["source"]
}

export interface ExternalCollaborator {
  userId: number
  username: string
  grants: ExternalGrant[]
}

export function deriveExternalCollaborators(
  matrix: Map<string, ProjectMember[]>,
  orgMemberIds: Set<number>,
  projectNames: Map<string, string>,
): ExternalCollaborator[] {
  const byUser = new Map<number, ExternalCollaborator>()
  for (const [projectId, members] of matrix) {
    for (const m of members) {
      if (orgMemberIds.has(m.userId)) continue
      // "org" can't legitimately win for a non-member; if it appears the
      // membership data is newer than our org-members snapshot — skip rather
      // than offer a revoke that the project-members endpoint can't honor.
      if (m.role.source === "org") continue
      let entry = byUser.get(m.userId)
      if (!entry) {
        entry = { userId: m.userId, username: m.username, grants: [] }
        byUser.set(m.userId, entry)
      }
      entry.grants.push({
        projectId,
        projectName: projectNames.get(projectId) ?? projectId,
        roleLevel: m.role.level,
        roleName: m.role.name,
        source: m.role.source,
      })
    }
  }
  const list = Array.from(byUser.values())
  for (const e of list) {
    e.grants.sort((a, b) => a.projectName.localeCompare(b.projectName))
  }
  return list.sort((a, b) => a.username.localeCompare(b.username))
}
