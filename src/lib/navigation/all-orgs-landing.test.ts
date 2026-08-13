import { describe, expect, it } from "vitest"
import { resolveAllOrgsLanding } from "./all-orgs-landing"

// AQU-864: `/orgs/all` used to dead-end for anyone with fewer than two org
// memberships — the "Your organization is ready" card with 0/0/0 stats and
// buttons wired to a null org id. These cases pin the landing decision.

const org = (id: number) => ({ id })
const project = (id: string) => ({ id })

describe("resolveAllOrgsLanding (AQU-864)", () => {
  it("renders the aggregate portfolio for 2+ memberships", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(1), org(2)],
        accessibleProjects: [project("p1")],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "portfolio" })
  })

  it("sends a single-membership caller to that org's home", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(7)],
        accessibleProjects: [project("p1")],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "org", orgId: 7 })
  })

  it("sends a project-only caller with no membership to the shared surface", () => {
    // The reported case: access is entirely project-level, so the portfolio has
    // nothing to aggregate but the caller demonstrably has projects.
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [project("p1"), project("p2")],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "shared" })
  })

  it("keeps the create-your-organization empty state for a caller with no access at all", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "empty" })
  })

  it("reports an error rather than an empty state when the org list failed to load", () => {
    // A failed fetch leaves `orgs` empty too; treating that as "no orgs" is how
    // a transient outage turned into a permanent-looking dead end.
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [],
        orgsError: "Failed to fetch",
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "error" })
  })

  it("prefers the error over a shared-projects redirect when the org list failed", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [project("p1")],
        orgsError: "500 Internal Server Error",
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "error" })
  })

  // AQU-883: at zero memberships the shared-vs-empty decision is made entirely
  // from the project directory, so its failure makes the caller's access
  // unknown — never the create-your-organization empty state.
  it("reports an error rather than an empty state when the project directory failed at zero memberships", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [],
        orgsError: null,
        accessibleProjectsError: "Failed to fetch",
      }),
    ).toEqual({ kind: "error" })
  })

  it("still routes a member to their org when only the project directory failed", () => {
    // Membership decides the landing on its own; the org home surfaces the
    // directory failure in its projects panel (AQU-883) with its own retry.
    expect(
      resolveAllOrgsLanding({
        orgs: [org(7)],
        accessibleProjects: [],
        orgsError: null,
        accessibleProjectsError: "Failed to fetch",
      }),
    ).toEqual({ kind: "org", orgId: 7 })
  })
})
