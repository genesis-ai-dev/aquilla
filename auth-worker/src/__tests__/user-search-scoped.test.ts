// FRO-321: scoped user search — /api/v2/users/search?scoped=1 must only
// return users that share an org or a maintainer-accessible project with the
// caller. This prevents global user enumeration via the invite picker.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

describe("GET /api/v2/users/search?scoped=1 (FRO-321)", () => {
  it("returns org-overlap users (both in the same org)", async () => {
    await seedUser(200, "alice-org")
    await seedUser(201, "bob-org")
    await seedUser(202, "carol-stranger")

    // Seed an org and add alice + bob to it
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Test Org', 200)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (10, 200, 400, 200)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (10, 201, 400, 200)",
    ).run()
    // carol is NOT in this org

    // alice searches for "bo" (should find bob-org but not carol-stranger)
    const res = await app.request(
      "/api/v2/users/search?prefix=bo&scoped=1",
      { method: "GET", headers: authHeader(await jwtFor("alice-org")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ username: string }> }
    expect(body.users.map((u) => u.username)).toContain("bob-org")
    expect(body.users.map((u) => u.username)).not.toContain("carol-stranger")
  })

  it("returns project-overlap users (both on a project where caller >= maintainer)", async () => {
    await seedUser(210, "maintainer-user")
    await seedUser(211, "project-collaborator")
    await seedUser(212, "unrelated-user")

    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, NULL, 210)",
    )
      .bind("proj-scope-test", "Scope Test")
      .run()
    // maintainer-user has maintainer (600) on the project
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 600, 210)",
    )
      .bind("proj-scope-test", 210)
      .run()
    // project-collaborator is a direct member too
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, 400, 210)",
    )
      .bind("proj-scope-test", 211)
      .run()
    // unrelated-user has no connection to the project

    const res = await app.request(
      "/api/v2/users/search?prefix=pr&scoped=1",
      { method: "GET", headers: authHeader(await jwtFor("maintainer-user")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ username: string }> }
    expect(body.users.map((u) => u.username)).toContain("project-collaborator")
    expect(body.users.map((u) => u.username)).not.toContain("unrelated-user")
  })

  it("unscoped search still returns global results (backward compat)", async () => {
    await seedUser(220, "global-alice")
    await seedUser(221, "global-bob")
    // No shared org or project

    // Without scoped=1, global-alice can find global-bob
    const res = await app.request(
      "/api/v2/users/search?prefix=global-b",
      { method: "GET", headers: authHeader(await jwtFor("global-alice")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ username: string }> }
    expect(body.users.map((u) => u.username)).toContain("global-bob")
  })

  it("scoped search excludes the caller themselves", async () => {
    await seedUser(230, "self-searcher")
    // Add to an org alone so they have scope context
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (20, 'Solo Org', 230)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (20, 230, 400, 230)",
    ).run()

    const res = await app.request(
      "/api/v2/users/search?prefix=self&scoped=1",
      { method: "GET", headers: authHeader(await jwtFor("self-searcher")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ username: string }> }
    // self-searcher should NOT appear in their own scoped search results
    expect(body.users.map((u) => u.username)).not.toContain("self-searcher")
  })
})
