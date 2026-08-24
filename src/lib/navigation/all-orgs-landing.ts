/**
 * AQU-864: decide what `/orgs/all` should actually show.
 *
 * The all-orgs overview aggregates member-org portfolios *and* project-level
 * grants from orgs the caller does not belong to. It has something to show
 * when there are 2+ memberships, when a single membership still has foreign
 * grants to list, or when access is entirely project-level. Below that the
 * page used to fall through to a single-org dashboard with no org in scope:
 * 0/0/0 stats and a "Your organization is ready" card whose create-project
 * dialog can't mount without an org id. `/` resumes to `/orgs/all` for anyone
 * whose stored org is `all`, so a user with project-level access but no org
 * membership landed on a page where nothing was clickable.
 *
 * Resolving the landing from the caller's actual access keeps `/orgs/all`
 * pointed at a surface that has a way forward. Foreign-org grants stay on
 * this page (not a single org's Projects table, and not a peer `/shared`
 * home).
 */
import type { OrgSummary } from "@/lib/frontier/orgs"
import { hasForeignOrgGrants } from "@/lib/frontier/shared-projects"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

export type AllOrgsLanding =
  /** Render the aggregate work list (member portfolios + shared grants). */
  | { kind: "portfolio" }
  /** Exactly one membership and nothing extra to aggregate; that org's home. */
  | { kind: "org"; orgId: number }
  /** No access anywhere yet — the genuine create-your-organization empty state. */
  | { kind: "empty" }
  /** A load failed in a way that makes the caller's access unknown — the org
   *  list itself, or (at zero memberships) the project directory that decides
   *  portfolio-vs-empty. "No access" is unknown here, not zero. */
  | { kind: "error" }

export function resolveAllOrgsLanding(input: {
  orgs: Pick<OrgSummary, "id">[]
  accessibleProjects: Pick<CloudProjectSummary, "id" | "orgId">[]
  orgsError: string | null
  accessibleProjectsError: string | null
}): AllOrgsLanding {
  // A failed org fetch also leaves `orgs` empty, which is indistinguishable
  // from a real zero — never let a fetch failure masquerade as "you have no
  // organizations" and bounce the user somewhere on that basis.
  if (input.orgsError) return { kind: "error" }
  if (input.orgs.length > 1) return { kind: "portfolio" }
  if (input.orgs.length === 1) {
    // A single membership is enough to send the caller to that org — unless
    // they also hold foreign-org grants, which must not land on that org's
    // Projects table (AQU-417). Stay here so those rows have a home.
    if (hasForeignOrgGrants(input.accessibleProjects, input.orgs)) {
      return { kind: "portfolio" }
    }
    return { kind: "org", orgId: input.orgs[0].id }
  }
  // AQU-883: at zero memberships the portfolio-vs-empty call is made entirely
  // from the project directory, and its fetch failing leaves the same empty
  // list as "nothing is shared with you" — don't bounce to the
  // create-your-organization dead end on a failure.
  if (input.accessibleProjectsError) return { kind: "error" }
  if (input.accessibleProjects.length > 0) return { kind: "portfolio" }
  return { kind: "empty" }
}
