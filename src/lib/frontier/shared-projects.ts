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
import type { PortfolioProject } from "@/lib/frontier/portfolio"

/** A shared grant projected into the all-orgs projects table. */
export type SharedPortfolioRow = PortfolioProject & {
  orgId?: number
  orgName?: string | null
  origin: "shared"
  grantedAt?: string | null
}

/** True when any accessible project lives outside the caller's member orgs. */
export function hasForeignOrgGrants(
  projects: Pick<CloudProjectSummary, "orgId">[],
  myOrgs: Pick<OrgSummary, "id">[],
): boolean {
  const myOrgIds = new Set(myOrgs.map((o) => o.id))
  return projects.some((p) => p.orgId == null || !myOrgIds.has(p.orgId))
}

/**
 * Map a project-level grant into a portfolio row so it can sit in the all-orgs
 * table. Guest orgs 403 the member-org portfolio endpoint, so progress fields
 * stay empty rather than fabricating 0%-of-N from file cell counts.
 */
export function toSharedPortfolioRow(p: CloudProjectSummary): SharedPortfolioRow {
  const files = p.files ?? []
  const withSource = files.find((f) => f.sourceLanguage)
  const withTarget = files.find((f) => f.targetLanguage)
  return {
    id: p.id,
    name: p.name,
    totalCells: 0,
    validatedCells: 0,
    filledCells: 0,
    aiDraftedCells: 0,
    lastEditAt: null,
    audioCells: 0,
    validatedAudioCells: 0,
    recordedMs: 0,
    deadlineAt: null,
    sourceLanguage: withSource?.sourceLanguage ?? null,
    targetLanguage: withTarget?.targetLanguage ?? null,
    pm: p.pm ?? null,
    orgId: p.orgId ?? undefined,
    orgName: p.orgName ?? null,
    origin: "shared",
    grantedAt: p.grantedAt ?? null,
  }
}

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
