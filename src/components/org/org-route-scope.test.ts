import { describe, expect, it } from "vitest"
import { isOrgScopedRoute } from "./org-route-scope"

describe("isOrgScopedRoute", () => {
  it("treats the org-level surfaces as org-scoped", () => {
    expect(isOrgScopedRoute("/assigned")).toBe(true)
    expect(isOrgScopedRoute("/members")).toBe(true)
    expect(isOrgScopedRoute("/projects")).toBe(true)
    expect(isOrgScopedRoute("/projects/abc")).toBe(true)
    expect(isOrgScopedRoute("/settings")).toBe(true)
    expect(isOrgScopedRoute("/settings/identity")).toBe(true)
    expect(isOrgScopedRoute("/teams")).toBe(true)
    expect(isOrgScopedRoute("/teams/group-1")).toBe(true)
  })

  // AQU-370: switching org (or "All organizations") from inside a project
  // workspace must re-navigate to the new org's overview. Before the fix the
  // `/project/:id` routes were not recognised as org-scoped, so the org
  // context changed but the view stayed on the stale project route.
  it("treats the project workspace routes as org-scoped", () => {
    expect(isOrgScopedRoute("/project/abc")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/file/xyz")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/settings")).toBe(true)
    expect(isOrgScopedRoute("/project/abc/comments")).toBe(true)
  })

  it("does not confuse the singular /project and plural /projects prefixes", () => {
    // Both should be scoped, but each must match on its own terms — the
    // presence of `/project` must not depend on `/projects` or vice-versa.
    expect(isOrgScopedRoute("/projectsomething")).toBe(false)
    expect(isOrgScopedRoute("/project")).toBe(true)
  })

  it("leaves non-org-scoped routes alone", () => {
    expect(isOrgScopedRoute("/")).toBe(false)
    expect(isOrgScopedRoute("/login")).toBe(false)
    expect(isOrgScopedRoute("/preferences")).toBe(false)
    expect(isOrgScopedRoute("/admin")).toBe(false)
  })
})
