/**
 * AQU-864: decide what `/orgs/all` should actually show.
 *
 * The all-orgs overview aggregates the portfolios of the orgs the caller is a
 * *member* of, so it only has something to aggregate at 2+ memberships — which
 * is exactly `OrgContext`'s `isAllOrgs` (`orgs.length > 1 && activeOrgId ==
 * null`). Below that threshold the page fell through to the single-org
 * dashboard branch with no org in scope: 0/0/0 stats and a "Your organization
 * is ready" card whose create-project dialog can't mount without an org id and
 * whose "Invite your team" button navigated nowhere. `/` resumes to
 * `/orgs/all` for anyone whose stored org is `all`, so a user with project-
 * level access but no org membership landed on a page where nothing was
 * clickable and none of their projects were reachable.
 *
 * Resolving the landing from the caller's actual access keeps `/orgs/all`
 * pointed at a surface that has a way forward.
 */
import type { OrgSummary } from "@/lib/frontier/orgs"
import type { CloudProjectSummary } from "@/lib/sync/cloud-projects"

export type AllOrgsLanding =
  /** 2+ memberships — render the aggregate portfolio (the page's real job). */
  | { kind: "portfolio" }
  /** Exactly one membership — nothing to aggregate; that org's home is the view. */
  | { kind: "org"; orgId: number }
  /** No membership but project-level grants — the "Shared with you" surface. */
  | { kind: "shared" }
  /** No access anywhere yet — the genuine create-your-organization empty state. */
  | { kind: "empty" }
  /** A load failed in a way that makes the caller's access unknown — the org
   *  list itself, or (at zero memberships) the project directory that decides
   *  shared-vs-empty. "No access" is unknown here, not zero. */
  | { kind: "error" }

export function resolveAllOrgsLanding(input: {
  orgs: Pick<OrgSummary, "id">[]
  accessibleProjects: Pick<CloudProjectSummary, "id">[]
  orgsError: string | null
  accessibleProjectsError: string | null
}): AllOrgsLanding {
  // A failed org fetch also leaves `orgs` empty, which is indistinguishable
  // from a real zero — never let a fetch failure masquerade as "you have no
  // organizations" and bounce the user somewhere on that basis.
  if (input.orgsError) return { kind: "error" }
  if (input.orgs.length > 1) return { kind: "portfolio" }
  if (input.orgs.length === 1) return { kind: "org", orgId: input.orgs[0].id }
  // AQU-883: at zero memberships the shared-vs-empty call is made entirely
  // from the project directory, and its fetch failing leaves the same empty
  // list as "nothing is shared with you" — don't bounce to the
  // create-your-organization dead end on a failure.
  if (input.accessibleProjectsError) return { kind: "error" }
  if (input.accessibleProjects.length > 0) return { kind: "shared" }
  return { kind: "empty" }
}
