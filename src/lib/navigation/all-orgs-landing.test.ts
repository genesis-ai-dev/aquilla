import { describe, expect, it } from "vitest"
import { resolveAllOrgsLanding } from "./all-orgs-landing"

// AQU-864: `/orgs/all` used to dead-end for anyone with fewer than two org
// memberships — the "Your organization is ready" card with 0/0/0 stats and
// buttons wired to a null org id. These cases pin the landing decision.

const org = (id: number) => ({ id })
const project = (id: string, orgId?: number | null) =>
  orgId === undefined ? { id } : { id, orgId }

describe("resolveAllOrgsLanding (AQU-864)", () => {
  it("renders the aggregate portfolio for 2+ memberships", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(1), org(2)],
        accessibleProjects: [project("p1", 1)],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "portfolio" })
  })

  it("sends a single-membership caller with no foreign grants to that org's home", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(7)],
        accessibleProjects: [project("p1", 7)],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "org", orgId: 7 })
  })

  it("keeps a single-membership caller on the aggregate when they also have a foreign-org grant", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [org(7)],
        accessibleProjects: [project("p1", 7), project("p2", 503)],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "portfolio" })
  })

  it("renders the aggregate for a project-only caller with no membership", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [project("p1", 503), project("p2", 777)],
        orgsError: null,
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "portfolio" })
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
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [],
        orgsError: "Failed to fetch",
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "error" })
  })

  it("prefers the error over a shared-projects portfolio when the org list failed", () => {
    expect(
      resolveAllOrgsLanding({
        orgs: [],
        accessibleProjects: [project("p1", 503)],
        orgsError: "500 Internal Server Error",
        accessibleProjectsError: null,
      }),
    ).toEqual({ kind: "error" })
  })

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
