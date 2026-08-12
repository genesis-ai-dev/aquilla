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
      }),
    ).toEqual({ kind: "portfolio" })
  })

  it("sends a single-membership caller to that org's home", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(7)],
        accessibleProjects: [project("p1")],
        orgsError: null,
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
      }),
    ).toEqual({ kind: "shared" })
  })

  it("keeps the create-your-organization empty state for a caller with no access at all", () => {
    expect(
      resolveAllOrgsLanding({ orgs: [], accessibleProjects: [], orgsError: null }),
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
      }),
    ).toEqual({ kind: "error" })
  })

  it("prefers the error over a shared-projects redirect when the org list failed", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [project("p1")],
        orgsError: "500 Internal Server Error",
      }),
    ).toEqual({ kind: "error" })
  })
})
