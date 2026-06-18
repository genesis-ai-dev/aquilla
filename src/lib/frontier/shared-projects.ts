// FRO-335: partition the caller's accessible projects into "this org" vs
// "shared with you". A project_members row created by a magic-link invite
// accept (or bulk-add, FRO-323) can point at a project in an org the caller
// does NOT belong to. Every dashboard surface is scoped to the active org, so
// those projects were URL-accessible but unreachable from any nav surface.
//
// "Shared with you" = accessible projects whose org the caller is not a
// member of (including projects with no org at all). Projects in the
// caller's OTHER orgs stay hidden here — they're reachable via the org
// switcher, same as before.

import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"
import type { OrgSummary } from "@/lib/frontier/orgs"

export interface PartitionedProjects {
  /** Projects belonging to the active org — the existing org-scoped list. */
  inActiveOrg: CloudProjectSummary[]
  /** Accessible projects in orgs the caller is not a member of. */
  sharedWithMe: CloudProjectSummary[]
}

export type ProjectPartitionScope = "active-org" | "all-orgs"

export function partitionSharedProjects(
  projects: CloudProjectSummary[],
  myOrgs: Pick<OrgSummary, "id">[],
  activeOrgId: number | null,
  scope: ProjectPartitionScope = "active-org",
): PartitionedProjects {
  if (scope === "all-orgs") {
    return { inActiveOrg: projects, sharedWithMe: [] }
  }

  const myOrgIds = new Set(myOrgs.map((o) => o.id))
  const inActiveOrg: CloudProjectSummary[] = []
  const sharedWithMe: CloudProjectSummary[] = []
  for (const p of projects) {
    if (p.orgId != null && p.orgId === activeOrgId) {
      inActiveOrg.push(p)
    } else if (p.orgId == null || !myOrgIds.has(p.orgId)) {
      sharedWithMe.push(p)
    }
    // else: project in another org I'm a member of — reachable via the org
    // switcher; intentionally not listed under the active org.
  }
  return { inActiveOrg, sharedWithMe }
}
