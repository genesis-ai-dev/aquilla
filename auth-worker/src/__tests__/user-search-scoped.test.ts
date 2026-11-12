// AQU-321: scoped user search — /api/v2/users/search must only return users
// that share an org or a maintainer-accessible project with the caller, for
// every non-admin caller regardless of whether they pass ?scoped=1. This
// prevents global user enumeration via the invite picker (or via a direct
// API call omitting the flag — see the pen-test regression test below).
// Platform admins keep an explicit unscoped opt-in for support lookups.

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

describe("GET /api/v2/users/search?scoped=1 (AQU-321)", () => {
  it("returns org-overlap users (both in the same org)", async () => {
    await seedUser(200, "alice-org")
    await seedUser(201, "bob-org")
    await seedUser(202, "carol-stranger")

    // Seed an org and add alice + bob to it
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Test Org', 200)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (10, 200, 600, 200)",
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

  it("pen-test regression: omitting ?scoped=1 no longer leaks cross-org users", async () => {
    await seedUser(220, "global-alice")
    await seedUser(221, "global-bob")
    // No shared org or project, and the caller doesn't pass scoped=1 at all —
    // this used to be the (unscoped, global) default. It must now behave
    // identically to the scoped path for an ordinary, non-admin caller.
    const res = await app.request(
      "/api/v2/users/search?prefix=global-b",
      { method: "GET", headers: authHeader(await jwtFor("global-alice")) },
      env,
    )
    // AQU-625: no roster she can see, so the search is rejected rather than
    // answered with an empty list she could keep walking.
    expect(res.status).toBe(403)
    const body = (await res.json()) as { rosterHidden?: boolean; users?: unknown }
    expect(body.rosterHidden).toBe(true)
    expect(body.users).toBeUndefined()
  })

  it("platform admin may still opt into unscoped search for cross-tenant support", async () => {
    // ADMIN_EMAILS is pinned to "root@example.com" in the test env (see
    // admin-routes.test.ts) — seedUser derives that email from the username.
    await seedUser(222, "root")
    await seedUser(223, "global-carol")
    // No shared org or project between root and global-carol.

    const res = await app.request(
      "/api/v2/users/search?prefix=global-c",
      { method: "GET", headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { users: Array<{ username: string }> }
    expect(body.users.map((u) => u.username)).toContain("global-carol")

    // The Share field sends scoped=1. An admin with no org membership can
    // still see every roster, so that request stays 200 and stays scoped.
    const scoped = await app.request(
      "/api/v2/users/search?prefix=global-c&scoped=1",
      { method: "GET", headers: authHeader(await jwtFor("root")) },
      env,
    )
    expect(scoped.status).toBe(200)
    const scopedBody = (await scoped.json()) as { users: Array<{ username: string }> }
    expect(scopedBody.users.map((u) => u.username)).not.toContain("global-carol")
  })

  it("scoped search excludes the caller themselves", async () => {
    await seedUser(230, "self-searcher")
    // Add to an org alone so they have scope context
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (20, 'Solo Org', 230)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (20, 230, 600, 230)",
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

  it("rejects search when the caller cannot see a member roster (AQU-625)", async () => {
    await seedUser(800, "hidden-contrib")
    await seedUser(801, "visible-lead")
    await seedUser(802, "roster-bob")
    await seedUser(803, "open-contrib")
    await seedUser(804, "roster-pal")

    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (80, 'Closed Roster', 801)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (81, 'Open Roster', 803)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings) VALUES (81, ?)",
    )
      .bind(JSON.stringify({ rosterViewMinRole: 400 }))
      .run()
    for (const [orgId, userId, role] of [
      [80, 800, 400],
      [80, 801, 500],
      [80, 802, 400],
      [81, 803, 400],
      [81, 804, 400],
    ] as const) {
      await env.AQUILLA_PG.prepare(
        "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
      )
        .bind(orgId, userId, role, userId)
        .run()
    }
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-aqu-625', 'Roster', 80, 802)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-aqu-625', 800, 400, 801)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-aqu-625', 801, 500, 801)",
    ).run()

    const cases = [
      { username: "hidden-contrib", prefix: "roster-b", status: 403 as const },
      { username: "visible-lead", prefix: "roster-b", status: 200 as const, contains: "roster-bob" },
      { username: "open-contrib", prefix: "roster-p", status: 200 as const, contains: "roster-pal" },
    ]
    for (const c of cases) {
      const res = await app.request(
        `/api/v2/users/search?prefix=${c.prefix}&scoped=1`,
        { method: "GET", headers: authHeader(await jwtFor(c.username)) },
        env,
      )
      expect({ username: c.username, status: res.status }).toEqual({
        username: c.username,
        status: c.status,
      })
      const body = (await res.json()) as { rosterHidden?: boolean; users?: Array<{ username: string }> }
      if (c.status === 403) {
        expect(body.rosterHidden).toBe(true)
      } else {
        expect(body.users?.map((u) => u.username)).toContain(c.contains)
      }
    }
  })
})
