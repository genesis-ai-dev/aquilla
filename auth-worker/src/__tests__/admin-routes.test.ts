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

  // AQU-1911: the admin console counted headings even where the project or its
  // org had turned "count headings" off, so its validated % disagreed with the
  // dashboards. Project answer, else org answer, else count them.
  it("GET /projects follows the count-headings setting, the project's then the org's", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('inherits', 'John', 1, 1), ('counts', 'Mark', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_settings (org_id, settings) VALUES (1, '{\"countStructuralCells\":false}')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_settings (project_id, settings) VALUES ('counts', '{\"countStructuralCells\":true}')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'inherits', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'counts', 'file.create', 'wendi', '{}', 1000, 1000, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, approved_count, filled_count, word_count,
                          structural_cell_count, structural_approved_count, structural_filled_count)
       VALUES ('f1', 'inherits', 'JHN', 'e1', 100, 40, 60, 500, 10, 4, 6),
              ('f2', 'counts', 'MRK', 'e2', 100, 40, 60, 500, 10, 4, 6)`,
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string; totalCells: number; validatedCells: number; filledCells: number; wordCount: number }>
    }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    // The org leaves headings out and this project follows it. Words never
    // take the setting, as on the dashboard.
    expect(byId.inherits).toMatchObject({ totalCells: 90, validatedCells: 36, filledCells: 54, wordCount: 500 })
    // This project counts them whatever its org says.
    expect(byId.counts).toMatchObject({ totalCells: 100, validatedCells: 40, filledCells: 60, wordCount: 500 })
  })

  // AQU-1911: "Stalled" is the dashboard's activity rule, so the console needs
  // the same clock — validations and takes restamp the progress rows, never
  // files.last_edit_at.
  it("GET /projects reports the latest activity, validations and takes included", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('reviewing', 'John', 1, 1), ('quiet', 'Mark', 1, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'reviewing', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'quiet', 'file.create', 'wendi', '{}', 1000, 1000, 2)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, last_edit_at, deleted_at)
       VALUES ('f1', 'reviewing', 'JHN', 'e1', 100, 60, 1000, NULL),
              ('f-gone', 'reviewing', 'Old JHN', 'e1', 100, 60, 1000, 123),
              ('f2', 'quiet', 'MRK', 'e2', 100, 60, 1000, NULL)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, position, archived_at) VALUES
         ('l1', 'reviewing', 'target', 'Greek', NULL, 0, NULL),
         ('l2', 'quiet', 'target', 'Greek', NULL, 0, NULL)`,
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO file_section_progress (project_id, file_id, scope, section_key, lane_id, total_count, filled_count, updated_at)
       VALUES ('reviewing', 'f1', 'file', '', 'l1', 100, 60, 5000),
              ('reviewing', 'f-gone', 'file', '', 'l1', 100, 60, 9000),
              ('quiet', 'f2', 'file', '', 'l2', 100, 60, 500)`,
    ).run()

    const res = await app.request("/api/v2/admin/projects", { headers: authHeader(await jwtFor("root")) }, env)
    const body = (await res.json()) as {
      projects: Array<{ id: string; lastEditAt: number | null; lastActivityAt: number | null }>
    }
    const byId = Object.fromEntries(body.projects.map((p) => [p.id, p]))
    // A validation pass restamped the progress row; the edit stamp stayed put.
    // The deleted file's newer row is not this project's work.
    expect(byId.reviewing).toMatchObject({ lastEditAt: 1000, lastActivityAt: 5000 })
    // Never earlier than the last cell edit.
    expect(byId.quiet).toMatchObject({ lastEditAt: 1000, lastActivityAt: 1000 })
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

  it("GET /orgs/:orgId/members lists members with role, joined and last active; 404s an unknown org", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "amos")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by, last_active_at) VALUES (1, 1, 700, 1, '2026-05-01'), (1, 2, 200, 1, NULL)",
    ).run()
    const headers = authHeader(await jwtFor("root"))

    const res = await app.request("/api/v2/admin/orgs/1/members", { headers }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      members: Array<{ userId: number; username: string; roleLevel: number; joinedAt: string | null; lastActiveAt: string | null }>
    }
    // Highest role first.
    expect(body.members.map((m) => [m.username, m.roleLevel])).toEqual([
      ["wendi", 700],
      ["amos", 200],
    ])
    expect(body.members[0].lastActiveAt).not.toBeNull()
    expect(body.members[1].lastActiveAt).toBeNull()
    expect(body.members[0].joinedAt).not.toBeNull()

    expect((await app.request("/api/v2/admin/orgs/999/members", { headers }, env)).status).toBe(404)
    expect((await app.request("/api/v2/admin/orgs/nope/members", { headers }, env)).status).toBe(404)
    const wendi = authHeader(await jwtFor("wendi"))
    expect((await app.request("/api/v2/admin/orgs/1/members", { headers: wendi }, env)).status).toBe(403)
  })

  it("GET /users/:userId returns the user with org and direct project memberships; 404s an unknown user", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 500, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('pa', 'John', 1, 1, NULL), ('pz', 'Old', 1, 1, '2026-01-01')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 1, 300, 1), ('pz', 1, 200, 1)",
    ).run()
    const headers = authHeader(await jwtFor("root"))

    const res = await app.request("/api/v2/admin/users/1", { headers }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: number; username: string }
      orgs: Array<{ orgId: number; name: string; roleLevel: number }>
      projects: Array<{ projectId: string; orgName: string; archived: boolean; roleLevel: number }>
    }
    expect(body.user).toMatchObject({ id: 1, username: "wendi" })
    expect(body.orgs).toEqual([expect.objectContaining({ orgId: 1, name: "CAS", roleLevel: 500 })])
    // Ordered by project name: John, then Old.
    expect(body.projects).toEqual([
      expect.objectContaining({ projectId: "pa", orgName: "CAS", archived: false, roleLevel: 300 }),
      expect.objectContaining({ projectId: "pz", orgName: "CAS", archived: true, roleLevel: 200 }),
    ])

    expect((await app.request("/api/v2/admin/users/999", { headers }, env)).status).toBe(404)
    expect((await app.request("/api/v2/admin/users/abc", { headers }, env)).status).toBe(404)
  })
})

describe("admin directory pages (AQU-2722)", () => {
  it("pages orgs, searches the whole list, and counts teams", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, '100% done', 1), (2, '1000 items', 1), (3, 'Beta', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, '100% done/crew', 1)",
    ).run()
    const headers = authHeader(await jwtFor("root"))

    const page = await app.request("/api/v2/admin/orgs?limit=1&sort=organization&dir=asc", { headers }, env)
    expect(page.status).toBe(200)
    const body = (await page.json()) as {
      orgs: Array<{ name: string; teamCount: number }>
      total: number
      limit: number
      offset: number
    }
    expect(body.total).toBe(3)
    expect(body.limit).toBe(1)
    expect(body.offset).toBe(0)
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0]).toMatchObject({ name: "100% done", teamCount: 1 })

    const found = await app.request(
      `/api/v2/admin/orgs?limit=10&q=${encodeURIComponent("100%")}`,
      { headers },
      env,
    )
    const matches = (await found.json()) as { orgs: Array<{ name: string }>; total: number }
    expect(matches.total).toBe(1)
    expect(matches.orgs.map((org) => org.name)).toEqual(["100% done"])

    const one = await app.request("/api/v2/admin/orgs/2", { headers }, env)
    expect(one.status).toBe(200)
    expect(await one.json()).toMatchObject({ org: { id: 2, name: "1000 items", teamCount: 0 } })
    expect((await app.request("/api/v2/admin/orgs/99", { headers }, env)).status).toBe(404)
  })

  it("pages projects before the file rollup and still searches every project", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1), (2, 'Other', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('a', 'Alpha', 1, 1), ('b', 'Beta', 1, 1), ('g', 'Gamma', 2, 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('e1', 1, 'a', 'file.create', 'wendi', '{}', 1000, 1000, 1), ('e2', 1, 'b', 'file.create', 'wendi', '{}', 1000, 1000, 2), ('e3', 1, 'g', 'file.create', 'wendi', '{}', 1000, 1000, 3)",
    ).run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO files (id, project_id, name, event_id, cell_count, word_count)
       VALUES ('fa', 'a', 'GEN', 'e1', 100, 10), ('fb', 'b', 'EXO', 'e2', 40, 10), ('fg', 'g', 'LEV', 'e3', 7, 10)`,
    ).run()
    const headers = authHeader(await jwtFor("root"))

    const first = await app.request("/api/v2/admin/projects?limit=1&sort=name&dir=asc", { headers }, env)
    const firstBody = (await first.json()) as {
      projects: Array<{ id: string; totalCells: number }>
      total: number
    }
    expect(firstBody.total).toBe(3)
    expect(firstBody.projects).toEqual([expect.objectContaining({ id: "a", totalCells: 100 })])

    const second = await app.request("/api/v2/admin/projects?limit=1&offset=1&sort=name&dir=asc", { headers }, env)
    const secondBody = (await second.json()) as { projects: Array<{ id: string; totalCells: number }> }
    expect(secondBody.projects).toEqual([expect.objectContaining({ id: "b", totalCells: 40 })])

    const search = await app.request("/api/v2/admin/projects?limit=10&q=beta", { headers }, env)
    const searchBody = (await search.json()) as { projects: Array<{ id: string }>; total: number }
    expect(searchBody.total).toBe(1)
    expect(searchBody.projects.map((project) => project.id)).toEqual(["b"])

    const scoped = await app.request("/api/v2/admin/projects?limit=10&orgId=2", { headers }, env)
    const scopedBody = (await scoped.json()) as { projects: Array<{ id: string; totalCells: number }>; total: number }
    expect(scopedBody.total).toBe(1)
    expect(scopedBody.projects).toEqual([expect.objectContaining({ id: "g", totalCells: 7 })])
  })

  it("filters needs-attention across every project and ranks overdue first", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)").run()
    await env.AQUILLA_PG.prepare(
      `INSERT INTO projects (id, name, org_id, created_by, deadline_at, archived_at) VALUES
        ('late', 'Late', 1, 1, '2020-01-01', NULL),
        ('quiet', 'Quiet', 1, 1, NULL, NULL),
        ('fine', 'Fine', 1, 1, NULL, NULL),
        ('old', 'Old', 1, 1, '2020-01-01', '2026-01-01')`,
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO events (id, schema_version, project_id, kind, author, payload, client_ts, server_ts, server_seq) VALUES ('eq', 1, 'quiet', 'file.create', 'wendi', '{}', 1000, 1000, 1)",
    ).run()
    const stale = Date.now() - 20 * 24 * 60 * 60 * 1000
    await env.AQUILLA_PG.prepare(
      "INSERT INTO files (id, project_id, name, event_id, cell_count, filled_count, last_edit_at) VALUES ('fq', 'quiet', 'GEN', 'eq', 20, 10, ?)",
    )
      .bind(stale)
      .run()
    const headers = authHeader(await jwtFor("root"))

    const res = await app.request(
      "/api/v2/admin/projects?limit=1&lens=needs-attention&sort=status&dir=desc",
      { headers },
      env,
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string }>
      total: number
      overdue: number
    }
    expect(body.total).toBe(2)
    expect(body.overdue).toBe(1)
    expect(body.projects.map((project) => project.id)).toEqual(["late"])
  })

  it("searches people by name and by the platform-admin role across the directory", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await seedUser(2, "amos")
    const headers = authHeader(await jwtFor("root"))

    const byName = await app.request("/api/v2/admin/users?limit=10&q=wendi", { headers }, env)
    const named = (await byName.json()) as { users: Array<{ username: string }>; total: number }
    expect(named.total).toBe(1)
    expect(named.users.map((user) => user.username)).toEqual(["wendi"])

    const byRole = await app.request(
      `/api/v2/admin/users?limit=10&q=${encodeURIComponent("platform admin")}`,
      { headers },
      env,
    )
    const admins = (await byRole.json()) as { users: Array<{ username: string }>; total: number }
    expect(admins.users.map((user) => user.username)).toEqual(["root"])
    expect(admins.total).toBe(1)
  })

  it("pages teams and searches by the name after the org prefix", async () => {
    await seedUser(7, "root")
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Alpha', 1), (2, 'Beta', 1)",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO groups (id, org_id, name, created_by) VALUES (1, 1, 'Alpha/translators', 1), (2, 2, 'Beta/reviewers', 1)",
    ).run()
    const headers = authHeader(await jwtFor("root"))

    const page = await app.request("/api/v2/admin/teams?limit=1&sort=team&dir=asc", { headers }, env)
    const body = (await page.json()) as { teams: Array<{ name: string }>; total: number }
    expect(body.total).toBe(2)
    expect(body.teams.map((team) => team.name)).toEqual(["Beta/reviewers"])

    const found = await app.request("/api/v2/admin/teams?limit=10&q=trans", { headers }, env)
    const matches = (await found.json()) as { teams: Array<{ name: string }>; total: number }
    expect(matches.total).toBe(1)
    expect(matches.teams.map((team) => team.name)).toEqual(["Alpha/translators"])
  })
})
