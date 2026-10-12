import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

// ADMIN_EMAILS is pinned to "root@example.com" (pg-test-env). These tests seed a
// "root" user (admin, by email) and a "wendi" user (ordinary) and assert the gate.

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

  // AQU-1071: the tenants table shows each org's active target-lane count, so the
  // billing band is legible across tenants instead of one Billing tab at a time.
  it("GET /orgs reports each org's active target-lane count, per the billing rule", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'NWT', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES
        ('pa', 'John', 1, 1, NULL),
        ('pb', 'Mark', 1, 1, NULL),
        ('pz', 'Retired', 1, 1, '2026-01-01')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO project_settings (project_id, settings, version) VALUES
        ('pa', '{"targetLanguage":"Bambara"}', 1),
        ('pb', '{"targetLanguage":"Bambara","targetLanes":["Songhai","Ignored"],"archivedLanes":["Songhai"]}', 1),
        ('pz', '{"targetLanguage":"Zarma"}', 1)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, archived_at) VALUES
        ('eslane01', 'pa', 'target', 'Spanish', 'es', '', NULL),
        ('eslane02', 'pa', 'target', 'Spanish', 'es', 'es-b', NULL),
        ('frlane01', 'pb', 'target', 'French', 'fr', '', NULL),
        ('swlane01', 'pb', 'target', 'Swahili', 'sw', 'sw', '2026-01-01'),
        ('zrlane01', 'pz', 'target', 'Zarma', 'dje', '', NULL)`,
    ).run()

    const res = await app.request("/api/v2/admin/orgs", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{ id: number; activeLanguageCount: number }>
    }
    const byId = Object.fromEntries(body.orgs.map((o) => [o.id, o]))
    // Two Spanish lanes on pa, one French lane on pb. pb's archived Swahili lane
    // and pz's archived project do not count, and settings.targetLanes is ignored.
    expect(byId[1]).toMatchObject({ activeLanguageCount: 3 })
    // An org with no projects answers 0 rather than omitting the field, so the
    // table can tell "none" apart from "this server doesn't report it".
    expect(byId[2]).toMatchObject({ activeLanguageCount: 0 })
  })

  it("GET /teams lists every group with org + member/grant counts", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "lead")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1), (1, 2, 500, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'CAS/team-a', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_members (group_id, user_id) VALUES (1, 1), (1, 2)",
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
      teams: Array<{
        id: number
        name: string
        orgName: string
        projectLeadUsername: string | null
        ownerUsername: string | null
        memberCount: number
        projectCount: number
      }>
    }
    expect(body.teams).toHaveLength(1)
    expect(body.teams[0]).toMatchObject({
      id: 1,
      name: "CAS/team-a",
      orgName: "CAS",
      projectLeadUsername: "lead",
      ownerUsername: "wendi",
      memberCount: 2,
      projectCount: 1,
    })
  })

  it("GET /teams leaves projectLeadUsername null when no project_lead is on the team", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'CAS/team-a', 1)",
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO group_members (group_id, user_id) VALUES (1, 1)").run()

    const res = await app.request("/api/v2/admin/teams", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { teams: Array<{ projectLeadUsername: string | null }> }
    expect(body.teams[0]?.projectLeadUsername).toBeNull()
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
      shared: false,
    })
  })

  // AQU-1626: the admin rollup is the same SUM over `files` the org dashboard
  // runs, and it had the same hole — a 500-cue caption track or a deleted file
  // counted as work, so platform admin and the project's own plan board
  // disagreed about how much there was to do.
  it("GET /projects leaves tombstoned files and hidden companions out of the rollup", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, word_count, last_edit_at, role, deleted_at)
       VALUES ('f1', 'pa', 'GEN', 'e1', 100, 40, 500, 1000, NULL, NULL),
              ('f-gone', 'pa', 'Old GEN', 'e1', 100, 100, 500, 1000, NULL, 123),
              ('f-cues', 'pa', 'GEN · audio cues', 'e1', 500, 0, 0, 1000, 'audio-cues', NULL),
              ('f-track', 'pa', 'GEN · captions', 'e1', 500, 0, 0, 1000, 'timeline-content', NULL)`,
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; totalCells: number; validatedCells: number; wordCount: number }>
    }
    expect(body.projects[0]).toMatchObject({ id: "pa", totalCells: 100, validatedCells: 40, wordCount: 500 })
  })

  // The LEFT join must stay a LEFT join: a project whose only file is hidden
  // still belongs in the admin list, at zero rather than missing entirely.
  it("GET /projects still lists a project whose only file is a hidden companion", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'pa', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, role)
       VALUES ('f-cues', 'pa', 'GEN · audio cues', 'e1', 500, 'audio-cues')`,
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    const body = (await res.json()) as { projects: Array<{ id: string; totalCells: number }> }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]).toMatchObject({ id: "pa", totalCells: 0 })
  })

  it("GET /projects flags a project as shared when a non-org member can access it", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "guest")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('own', 'John', 1, 1), ('guested', 'Matthew', 1, 1), ('teamed', 'Exodus', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('guested', 2, 100, 1)",
    ).run()
    await seedUser(3, "bob")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Reviewers', 1)",
    ).run()
    await env.AQUILLA_PG.prepare("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 3, 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'teamed', 100, 1)",
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; shared: boolean }> }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p.shared]))
    expect(byId.own).toBe(false)
    expect(byId.guested).toBe(true)
    expect(byId.teamed).toBe(true)
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
