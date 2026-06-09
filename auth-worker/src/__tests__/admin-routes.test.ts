import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// PLATFORM_ADMINS is pinned to "root" in vitest.config.ts. These tests seed a
// "root" user (admin) and a "wendi" user (ordinary) and assert the gate.

describe("/api/v2/admin/* platform-admin gate", () => {
  it("403s a non-allowlisted user and 401s an anonymous caller", async () => {
    await seedUser(1, "wendi")
    const denied = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(denied.status).toBe(403)

    const anon = await app.request("/api/v2/admin/me", {}, env)
    expect(anon.status).toBe(401)
  })

  it("GET /me returns isPlatformAdmin for an allowlisted user", async () => {
    await seedUser(7, "root")
    const res = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ isPlatformAdmin: true, username: "root" })
  })

  it("GET /overview rolls up orgs/users/active+archived projects across tenants", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "amos")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'NWT', 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by, last_active_at) VALUES (1, 1, 700, 1, now()), (2, 2, 700, 2, now() - interval '30 days')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('pa', 'John', 1, 1, NULL), ('pb', 'Mark', 2, 2, NULL), ('pz', 'Old', 1, 1, '2026-01-01')",
    ).run()

    const res = await app.request("/api/v2/admin/overview", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    // 3 users (root, wendi, amos), 2 orgs, 2 active + 1 archived project,
    // 1 user active in the last 7 days (wendi; amos was 30 days ago).
    expect(await res.json()).toMatchObject({
      orgs: 2,
      users: 3,
      activeProjects: 2,
      archivedProjects: 1,
      activeUsers7d: 1,
    })
  })

  it("GET /orgs lists every org with owner + member/project counts", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1), ('pb', 'Mark', 1, 1)",
    ).run()

    const res = await app.request("/api/v2/admin/orgs", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{ id: number; ownerUsername: string; memberCount: number; projectCount: number }>
    }
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0]).toMatchObject({ id: 1, ownerUsername: "wendi", memberCount: 1, projectCount: 2 })
  })

  it("GET /teams lists every group with org + member/grant counts", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'CAS/team-a', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level) VALUES (1, 'pa', 400)",
    ).run()

    const res = await app.request("/api/v2/admin/teams", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      teams: Array<{ id: number; name: string; orgName: string; memberCount: number; projectCount: number }>
    }
    expect(body.teams).toHaveLength(1)
    expect(body.teams[0]).toMatchObject({
      id: 1,
      name: "CAS/team-a",
      orgName: "CAS",
      memberCount: 1,
      projectCount: 1,
    })
  })

  it("GET /projects rolls up cells/words per project across orgs", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'pa', 'file.create', 'wendi', '{}', 2000, 2000, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, word_count, last_edit_at) VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 500, 1000), ('f2', 'pa', 'EXO', 'e2', 100, 10, 300, 2000)",
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; orgName: string; creatorUsername: string; totalCells: number; validatedCells: number; wordCount: number; lastEditAt: number }>
    }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]).toMatchObject({
      id: "pa",
      orgName: "CAS",
      creatorUsername: "wendi",
      totalCells: 200,
      validatedCells: 50,
      wordCount: 800,
      lastEditAt: 2000,
    })
  })

  it("GET /activity returns the cross-tenant feed, honours limit, and joins usernames", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO activity_logs (id, user_id, activity_type, description, timestamp) VALUES (1, 1, 'login', 'a', '2026-05-01'), (2, 1, 'edit', 'b', '2026-05-02'), (3, 1, 'edit', 'c', '2026-05-03')",
    ).run()

    const res = await app.request("/api/v2/admin/activity?limit=2", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { activity: Array<{ id: number; username: string; type: string }> }
    expect(body.activity).toHaveLength(2)
    // newest first
    expect(body.activity[0]).toMatchObject({ id: 3, username: "wendi", type: "edit" })
    expect(body.activity[1].id).toBe(2)
  })
})
