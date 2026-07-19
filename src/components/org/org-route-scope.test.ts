import { describe, expect, it } from "vitest"
import { isOrgScopedRoute } from "./org-route-scope"

describe("isOrgScopedRoute", () => {
  it("treats the org shell as org-scoped", () => {
    expect(isOrgScopedRoute("/orgs/all")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/members")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/members/matrix")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/settings/identity")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/teams")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/assigned")).toBe(true)
    expect(isOrgScopedRoute("/orgs/7/archived")).toBe(true)
  })

  // AQU-370: switching org (or "All organizations") from inside a project
  // workspace must re-navigate to the new org's overview. Before the fix the
  // `/project/:id` routes were not recognised as org-scoped, so the org
  // context changed but the view stayed on the stale project route.
  it("treats the project workspace routes as org-scoped", () => {
    expect(isOrgScopedRoute("/project/abc")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/file/xyz")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/settings")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/settings/ai")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/comments")).toBe(true)
  })

  it("treats project overview list paths as org-scoped", () => {
    expect(isOrgScopedRoute("/projects")).toBe(true)
    expect(isOrgScopedRoute("/projects/abc")).toBe(true)
  })

  it("does not confuse the singular /project and plural /projects prefixes", () => {
    expect(isOrgScopedRoute("/projectsomething")).toBe(false)
    expect(isOrgScopedRoute("/project")).toBe(true)
  })

  it("leaves non-org-scoped routes alone", () => {
    expect(isOrgScopedRoute("/")).toBe(false)
    expect(isOrgScopedRoute("/login")).toBe(false)
    expect(isOrgScopedRoute("/preferences")).toBe(false)
    expect(isOrgScopedRoute("/admin")).toBe(false)
    expect(isOrgScopedRoute("/shared")).toBe(false)
    // Flat legacy org paths are no longer routes — not treated as scoped.
    expect(isOrgScopedRoute("/members")).toBe(false)
    expect(isOrgScopedRoute("/settings")).toBe(false)
  })
})
