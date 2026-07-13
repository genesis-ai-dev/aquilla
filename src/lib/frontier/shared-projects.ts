// AQU-335: partition the caller's accessible projects into "this org" vs
// "shared with you". A project_members row created by a magic-link invite
// accept (or bulk-add, AQU-323) can point at a project in an org the caller
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
  const myOrgIds = new Set(myOrgs.map((o) => o.id))

  if (scope === "all-orgs") {
    // AQU-475: the all-orgs aggregate is built from getPortfolios(), which
    // only knows about orgs the caller is a MEMBER of. A project reached
    // purely via a project-level invite (no org membership at all) never
    // appears there — so here "shared with me" = accessible projects whose
    // org I do not belong to (including org-less projects), same rule as
    // the active-org scope, just without an activeOrgId to compare against.
    const inActiveOrg: CloudProjectSummary[] = []
    const sharedWithMe: CloudProjectSummary[] = []
    for (const p of projects) {
      if (p.orgId != null && myOrgIds.has(p.orgId)) {
        inActiveOrg.push(p)
      } else {
        sharedWithMe.push(p)
      }
    }
    return { inActiveOrg, sharedWithMe }
  }

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
