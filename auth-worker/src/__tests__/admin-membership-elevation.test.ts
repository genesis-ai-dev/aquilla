// AQU-1322 part 2: admin power applies only while elevated, on team, invite and
// project membership writes (the org member add/remove gate is #750, see
// org-members-admin-elevation.test.ts).
//
// The base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin. Org 1 is a tenant root does not
// belong to; org 2 is one where root is a genuine Maintainer.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7

const sql = (query: string, ...binds: unknown[]) =>
  env.AQUILLA_PG.prepare(query)
    .bind(...binds)
    .run()

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  await seedUser(1, "owner")
  await seedUser(2, "alice")
  await seedUser(3, "bob")
  await seedUser(4, "mara") // genuine org-1 Maintainer
  await seedUser(5, "carol") // org-1 Contributor, team-1 Maintainer
  await seedUser(6, "dana") // project Project Lead on proj-a
  await seedUser(8, "eve") // project Maintainer on proj-a
  await seedUser(9, "outsider")
  await seedUser(10, "newbie") // a fresh account with no memberships (access links)
  await seedUser(ROOT_ID, "root")

  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'PartnerOrg', 1)")
  await sql("INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'RootOrg', 1)")
  for (const [org, user, role] of [
    [1, 1, 700],
    [1, 2, 400],
    [1, 3, 200],
    [1, 4, 600],
    [1, 5, 400],
    [2, 1, 700],
    [2, 2, 400],
    [2, ROOT_ID, 600],
  ]) {
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, 1)", org, user, role)
  }
  await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'Alpha', 1)")
  await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (20, 2, 'RootTeam', 1)")
  await sql("INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1)")
  await sql("INSERT INTO group_members (group_id, user_id, role_level, added_by) VALUES (10, 5, 600, 1)")
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'ProjA', 1, 1)")
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-b', 'ProjB', 2, 1)")
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-c', 'ProjC', 1, ?)", ROOT_ID)
  await sql("INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (10, 'proj-a', 300, 1)")
  await sql("INSERT INTO org_invites (token, org_id, role_level, created_by, email) VALUES ('tok-org-1', 1, 400, 1, 'x@example.com')")
  await sql("INSERT INTO project_invites (token, project_id, role_level, created_by) VALUES ('tok-proj-1', 'proj-a', 300, 1)")
  await sql(
    "INSERT INTO project_access_links (token, project_id, user_id, pin_hash, role_level, created_by, expires_at) VALUES ('link-1', 'proj-a', 10, 'x', 400, 1, '2099-01-01T00:00:00.000Z')",
  )
  for (const [user, role] of [
    [2, 300],
    [6, 500],
    [8, 600],
  ]) {
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-a', ?, ?, 1)", user, role)
  }
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
})

const call = async (as: string, method: string, path: string, body?: unknown, jwt?: string) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(jwt ?? (await jwtFor(as))),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

const elevate = async (jwt: string) => {
  const req = await app.request("/api/v2/admin/elevation/request", { method: "POST", headers: authHeader(jwt) }, env)
  const { devCode } = (await req.json()) as { devCode?: string }
  const res = await app.request(
    "/api/v2/admin/elevation/verify",
    { method: "POST", headers: authHeader(jwt), body: JSON.stringify({ code: devCode }) },
    env,
  )
  expect(res.status).toBe(200)
}

type AuditRow = { user_id: number; action: string; detail: string }
const auditRows = async (): Promise<AuditRow[]> => {
  const res = await env.AQUILLA_PG.prepare(
    "SELECT user_id, action, detail FROM admin_audit_log WHERE action NOT LIKE 'elevation.%' ORDER BY id",
  ).all<AuditRow>()
  return res.results ?? []
}

type Case = { name: string; method: string; path: string; body?: unknown; action: string }

const orgCases: Case[] = [
  { name: "team create", method: "POST", path: "/api/v2/orgs/1/groups", body: { name: "Beta" }, action: "team.create" },
  { name: "team rename", method: "PATCH", path: "/api/v2/orgs/1/groups/10", body: { name: "Alpha2" }, action: "team.update" },
  { name: "team delete", method: "DELETE", path: "/api/v2/orgs/1/groups/10", action: "team.delete" },
  { name: "team member add", method: "POST", path: "/api/v2/orgs/1/groups/10/members", body: { username: "bob" }, action: "team.member.add" },
  { name: "team member remove", method: "DELETE", path: "/api/v2/orgs/1/groups/10/members/2", action: "team.member.remove" },
  { name: "team member role", method: "PATCH", path: "/api/v2/orgs/1/groups/10/members/2", body: { roleLevel: 600 }, action: "team.member.role" },
  { name: "team project attach", method: "POST", path: "/api/v2/orgs/1/groups/10/projects", body: { projectId: "proj-c", roleLevel: 400 }, action: "team.project.attach" },
  { name: "team project role", method: "PATCH", path: "/api/v2/orgs/1/groups/10/projects/proj-a", body: { roleLevel: 400 }, action: "team.project.role" },
  { name: "team project detach", method: "DELETE", path: "/api/v2/orgs/1/groups/10/projects/proj-a", action: "team.project.detach" },
  { name: "org invite create", method: "POST", path: "/api/v2/orgs/1/invites", body: { role: 400, email: "new@example.com" }, action: "org.invite.create" },
  { name: "org invite revoke", method: "DELETE", path: "/api/v2/orgs/1/invites/tok-org-1", action: "org.invite.revoke" },
]

const projectCases: Case[] = [
  { name: "project member add", method: "POST", path: "/api/v2/projects/proj-a/members", body: { username: "bob", role: 300 }, action: "project.member.grant" },
  { name: "project member batch add", method: "POST", path: "/api/v2/projects/proj-a/members", body: { members: [{ username: "bob", role: 300 }] }, action: "project.member.grant" },
  { name: "project member re-role", method: "POST", path: "/api/v2/projects/proj-a/members", body: { username: "alice", role: 400 }, action: "project.member.role" },
  { name: "project member remove", method: "DELETE", path: "/api/v2/projects/proj-a/members/2", action: "project.member.remove" },
  { name: "project member revoke-all", method: "POST", path: "/api/v2/projects/proj-a/members/2/revoke-all", action: "project.member.revoke_all" },
  { name: "project invite create", method: "POST", path: "/api/v2/projects/proj-a/invites", body: { role: 300, email: "new@example.com" }, action: "project.invite.create" },
  { name: "project invite revoke", method: "DELETE", path: "/api/v2/projects/proj-a/invites/tok-proj-1", action: "project.invite.revoke" },
  { name: "multi-project invite", method: "POST", path: "/api/v2/invites/multi", body: { projectIds: ["proj-a"], roleLevel: 300 }, action: "project.invite.create" },
  { name: "access link mint", method: "POST", path: "/api/v2/access-links", body: { projectId: "proj-a", userId: 10, pin: "123456", roleLevel: 300 }, action: "project.access_link.create" },
  { name: "access link revoke", method: "POST", path: "/api/v2/access-links/link-1/revoke", action: "project.access_link.revoke" },
]

describe.each([
  ["org-scoped", orgCases],
  ["project-scoped", projectCases],
])("platform admin with no genuine role, %s routes", (_label, cases) => {
  it.each(cases)("$name: refused without elevation, writes nothing", async (c) => {
    const res = await call("root", c.method, c.path, c.body)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain("elevation required")
    expect(await auditRows()).toHaveLength(0)
  })

  it.each(cases)("$name: succeeds once elevated, with exactly one audit row", async (c) => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", c.method, c.path, c.body, jwt)
    expect(res.status).toBe(200)
    const rows = await auditRows()
    expect(rows.map((r) => r.action)).toEqual([c.action])
    expect(rows[0].user_id).toBe(ROOT_ID)
  })
})

describe("audit detail for team and invite changes", () => {
  it("records groupId, projectId and the invite email, never the token", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    await call("root", "POST", "/api/v2/orgs/1/groups/10/projects", { projectId: "proj-c", roleLevel: 400 }, jwt)
    const mint = await call("root", "POST", "/api/v2/orgs/1/invites", { role: 400, email: "new@example.com" }, jwt)
    const { token } = (await mint.json()) as { token: string }
    await call("root", "PATCH", "/api/v2/orgs/1/groups/10/members/2", { roleLevel: 600 }, jwt)

    const rows = await auditRows()
    const details = rows.map((r) => JSON.parse(r.detail))
    expect(details[0]).toMatchObject({
      action: "team.project.attach",
      scope: "team",
      orgId: 1,
      groupId: 10,
      projectId: "proj-c",
      target: null,
      roleBefore: null,
      roleAfter: 400,
    })
    expect(details[1]).toMatchObject({
      action: "org.invite.create",
      scope: "org",
      orgId: 1,
      groupId: null,
      target: null,
      roleAfter: 400,
      email: "new@example.com",
    })
    expect(rows[1].detail).not.toContain(token)
    expect(details[2]).toMatchObject({
      action: "team.member.role",
      groupId: 10,
      target: { userId: 2, username: "alice" },
      roleBefore: null,
      roleAfter: 600,
    })
  })
})

describe("platform admin who is a genuine org Maintainer", () => {
  it("runs the team routes on their own org without elevation", async () => {
    const create = await call("root", "POST", "/api/v2/orgs/2/groups", { name: "Beta" })
    expect(create.status).toBe(200)
    const rename = await call("root", "PATCH", "/api/v2/orgs/2/groups/20", { name: "RootTeam2" })
    expect(rename.status).toBe(200)
    const add = await call("root", "POST", "/api/v2/orgs/2/groups/20/members", { username: "alice" })
    expect(add.status).toBe(200)
    const role = await call("root", "PATCH", "/api/v2/orgs/2/groups/20/members/2", { roleLevel: 600 })
    expect(role.status).toBe(200)
    const attach = await call("root", "POST", "/api/v2/orgs/2/groups/20/projects", { projectId: "proj-b", roleLevel: 600 })
    expect(attach.status).toBe(200)
    const remove = await call("root", "DELETE", "/api/v2/orgs/2/groups/20/members/2")
    expect(remove.status).toBe(200)
  })

  it("caps a team-to-project grant at the genuine 600, not 700, without elevation", async () => {
    const tooHigh = await call("root", "POST", "/api/v2/orgs/2/groups/20/projects", { projectId: "proj-b", roleLevel: 700 })
    expect(tooHigh.status).toBe(403)
    expect(await tooHigh.json()).toEqual({ error: "invalid or too-high role level" })
    const row = await env.AQUILLA_PG.prepare("SELECT 1 FROM group_project_grants WHERE group_id = 20").first()
    expect(row).toBeNull()
  })

  it("keeps the genuine 600 cap even while elevated (the genuine role passed the gate)", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "POST", "/api/v2/orgs/2/groups/20/projects", { projectId: "proj-b", roleLevel: 700 }, jwt)
    expect(res.status).toBe(403)
  })

  it("an elevated admin with no genuine role on the org uses 700 for the same grant", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "POST", "/api/v2/orgs/1/groups/10/projects", { projectId: "proj-c", roleLevel: 700 }, jwt)
    expect(res.status).toBe(200)
  })

  it("still needs elevation for invites (the gate is Owner, 600 is not enough)", async () => {
    const res = await call("root", "POST", "/api/v2/orgs/2/invites", { role: 400 })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain("elevation required")
  })

  it("caps a team role grant at the genuine 600 without elevation", async () => {
    await sql("INSERT INTO group_members (group_id, user_id, added_by) VALUES (20, 2, 1)")
    const res = await call("root", "PATCH", "/api/v2/orgs/2/groups/20/members/2", { roleLevel: 700 })
    expect(res.status).toBe(400)
  })
})

describe("platform admin who is a genuine project owner", () => {
  it("runs the member and invite routes without elevation", async () => {
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-c', 2, 300, ?)", ROOT_ID)
    const add = await call("root", "POST", "/api/v2/projects/proj-c/members", { username: "bob", role: 300 })
    expect(add.status).toBe(200)
    const invite = await call("root", "POST", "/api/v2/projects/proj-c/invites", { role: 300 })
    expect(invite.status).toBe(200)
    const { token } = (await invite.json()) as { token: string }
    const revokeInvite = await call("root", "DELETE", `/api/v2/projects/proj-c/invites/${token}`)
    expect(revokeInvite.status).toBe(200)
    const revokeAll = await call("root", "POST", "/api/v2/projects/proj-c/members/2/revoke-all")
    expect(revokeAll.status).toBe(200)
    const remove = await call("root", "DELETE", "/api/v2/projects/proj-c/members/3")
    expect(remove.status).toBe(200)
  })
})

describe("non-admin callers see the same responses and no audit rows", () => {
  it("org Maintainer runs the team routes", async () => {
    expect((await call("mara", "POST", "/api/v2/orgs/1/groups", { name: "Beta" })).status).toBe(200)
    expect((await call("mara", "PATCH", "/api/v2/orgs/1/groups/10", { name: "Alpha2" })).status).toBe(200)
    expect((await call("mara", "POST", "/api/v2/orgs/1/groups/10/members", { username: "bob" })).status).toBe(200)
    expect((await call("mara", "PATCH", "/api/v2/orgs/1/groups/10/members/2", { roleLevel: 600 })).status).toBe(200)
    expect((await call("mara", "POST", "/api/v2/orgs/1/groups/10/projects", { projectId: "proj-c", roleLevel: 600 })).status).toBe(200)
    const tooHigh = await call("mara", "PATCH", "/api/v2/orgs/1/groups/10/projects/proj-a", { roleLevel: 700 })
    expect(tooHigh.status).toBe(403)
    expect(await tooHigh.json()).toEqual({ error: "invalid or too-high role level" })
    expect((await call("mara", "DELETE", "/api/v2/orgs/1/groups/10/projects/proj-a")).status).toBe(200)
    expect((await call("mara", "DELETE", "/api/v2/orgs/1/groups/10/members/3")).status).toBe(200)
    expect((await call("mara", "DELETE", "/api/v2/orgs/1/groups/10")).status).toBe(200)
    expect(await auditRows()).toHaveLength(0)
  })

  it("org Maintainer still cannot manage invites", async () => {
    const res = await call("mara", "POST", "/api/v2/orgs/1/invites", { role: 400 })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "only org owners can invite members" })
    const del = await call("mara", "DELETE", "/api/v2/orgs/1/invites/tok-org-1")
    expect(del.status).toBe(403)
    expect(await del.json()).toEqual({ error: "only org owners can revoke invites" })
  })

  it("a user with no org role gets the original 403", async () => {
    const res = await call("outsider", "POST", "/api/v2/orgs/1/groups", { name: "Beta" })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "org role >= maintainer required" })
    const role = await call("outsider", "PATCH", "/api/v2/orgs/1/groups/10/members/2", { roleLevel: 100 })
    expect(role.status).toBe(403)
    expect(await role.json()).toEqual({ error: "org or team role >= maintainer required to change team roles" })
  })

  it("team Maintainer keeps the strictly-below rule", async () => {
    const down = await call("carol", "PATCH", "/api/v2/orgs/1/groups/10/members/2", { roleLevel: 100 })
    expect(down.status).toBe(200)
    const peer = await call("carol", "PATCH", "/api/v2/orgs/1/groups/10/members/2", { roleLevel: 600 })
    expect(peer.status).toBe(403)
    expect(await peer.json()).toEqual({ error: "cannot grant a team role at or above your own" })
    expect(await auditRows()).toHaveLength(0)
  })

  it("org Owner mints and revokes invites", async () => {
    const mint = await call("owner", "POST", "/api/v2/orgs/1/invites", { role: 400, email: "new@example.com" })
    expect(mint.status).toBe(200)
    const del = await call("owner", "DELETE", "/api/v2/orgs/1/invites/tok-org-1")
    expect(del.status).toBe(200)
    expect(await del.json()).toEqual({ ok: true })
    expect(await auditRows()).toHaveLength(0)
  })

  it("project Lead adds, project Maintainer removes", async () => {
    const add = await call("dana", "POST", "/api/v2/projects/proj-a/members", { username: "bob", role: 300 })
    expect(add.status).toBe(200)
    const remove = await call("eve", "DELETE", "/api/v2/projects/proj-a/members/2")
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ removed: true })
    const invite = await call("dana", "POST", "/api/v2/projects/proj-a/invites", { role: 300 })
    expect(invite.status).toBe(200)
    expect(await auditRows()).toHaveLength(0)
  })

  it("project outsider gets the original 403", async () => {
    const res = await call("outsider", "POST", "/api/v2/projects/proj-a/members", { username: "bob", role: 300 })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: "no access to project" })
  })
})

describe("invite token reads", () => {
  const reads = [
    { name: "org invites", path: "/api/v2/orgs/1/invites", owner: "owner", denied: "mara", deniedBody: { error: "only org owners can view invites" } },
    { name: "project invites", path: "/api/v2/projects/proj-a/invites", owner: "dana", denied: "outsider", deniedBody: null },
  ]

  it.each(reads)("$name: un-elevated admin gets 403", async (r) => {
    const res = await call("root", "GET", r.path)
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain("elevation required")
  })

  it.each(reads)("$name: elevated admin reads, with no audit row", async (r) => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await call("root", "GET", r.path, undefined, jwt)
    expect(res.status).toBe(200)
    expect(await auditRows()).toHaveLength(0)
  })

  it.each(reads)("$name: non-admin behaviour is unchanged", async (r) => {
    expect((await call(r.owner, "GET", r.path)).status).toBe(200)
    const denied = await call(r.denied, "GET", r.path)
    expect(denied.status).toBe(403)
    if (r.deniedBody) expect(await denied.json()).toEqual(r.deniedBody)
  })
})

describe("multi-project invites and access links for non-admins", () => {
  it("a project Lead mints a multi-project invite and an access link; no audit rows", async () => {
    const multi = await call("dana", "POST", "/api/v2/invites/multi", { projectIds: ["proj-a"], roleLevel: 300 })
    expect(multi.status).toBe(200)
    const mint = await call("dana", "POST", "/api/v2/access-links", { projectId: "proj-a", userId: 10, pin: "123456" })
    expect(mint.status).toBe(200)
    const revoke = await call("dana", "POST", "/api/v2/access-links/link-1/revoke")
    expect(revoke.status).toBe(200)
    expect(await revoke.json()).toEqual({ token: "link-1", revoked: true })
    expect(await auditRows()).toHaveLength(0)
  })

  it("a project outsider still gets the original 404", async () => {
    const res = await call("outsider", "POST", "/api/v2/access-links", { projectId: "proj-a", userId: 10, pin: "123456" })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "project not found: proj-a" })
  })

  it("the access link audit row names the bound user and never the token or pin", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const mint = await call("root", "POST", "/api/v2/access-links", { projectId: "proj-a", userId: 10, pin: "123456", roleLevel: 300 }, jwt)
    const { token } = (await mint.json()) as { token: string }
    const rows = await auditRows()
    expect(JSON.parse(rows[0].detail)).toMatchObject({
      action: "project.access_link.create",
      target: { userId: 10, username: "newbie" },
      projectId: "proj-a",
      roleAfter: 300,
    })
    expect(rows[0].detail).not.toContain(token)
    expect(rows[0].detail).not.toContain("123456")
  })
})

describe("platform admin who is only a genuine project Maintainer", () => {
  it("still needs elevation to add a member (admin power decides, not the real role)", async () => {
    await sql("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-a', ?, 600, 1)", ROOT_ID)
    const res = await call("root", "POST", "/api/v2/projects/proj-a/members", { username: "bob", role: 400 })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).toContain("elevation required")
    expect(await auditRows()).toHaveLength(0)
  })
})

describe("GET /:orgId/project-invites", () => {
  it("un-elevated admin gets 403; elevated admin reads with no audit row", async () => {
    const denied = await call("root", "GET", "/api/v2/orgs/1/project-invites")
    expect(denied.status).toBe(403)
    expect(((await denied.json()) as { error: string }).error).toContain("elevation required")
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const ok = await call("root", "GET", "/api/v2/orgs/1/project-invites", undefined, jwt)
    expect(ok.status).toBe(200)
    expect(await auditRows()).toHaveLength(0)
  })

  it("non-admin behaviour is unchanged", async () => {
    expect((await call("owner", "GET", "/api/v2/orgs/1/project-invites")).status).toBe(200)
    const denied = await call("mara", "GET", "/api/v2/orgs/1/project-invites")
    expect(denied.status).toBe(403)
    expect(await denied.json()).toEqual({ error: "only org owners can list pending invites" })
  })
})

// AQU-1540: project create into a named org (and its teamIds attach) follows the
// same rule: genuine org or team roles first, admin power only while elevated.
describe("POST /api/v2/projects into an org", () => {
  const create = (as: string, body: Record<string, unknown>, jwt?: string) =>
    call(as, "POST", "/api/v2/projects", { id: "new-1", name: "New", ...body }, jwt)
  const projectRow = () =>
    env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = 'new-1'").first<{ org_id: number }>()
  const teamGrant = () =>
    env.AQUILLA_PG.prepare("SELECT role_level FROM group_project_grants WHERE project_id = 'new-1'").first()

  it("un-elevated admin outside the org is refused, with or without teamIds; nothing is written", async () => {
    for (const body of [{ orgId: 1 }, { orgId: 1, teamIds: [10] }]) {
      const res = await create("root", body)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toMatch(/^elevation required/)
    }
    expect(await projectRow()).toBeNull()
    expect(await teamGrant()).toBeNull()
    expect(await auditRows()).toEqual([])
  })

  it("elevated admin creates and attaches, with a project.create and a team.project.attach row", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await create("root", { orgId: 1, teamIds: [10] }, jwt)
    expect(res.status).toBe(200)
    expect((await projectRow())?.org_id).toBe(1)
    expect(await teamGrant()).not.toBeNull()

    const rows = await auditRows()
    expect(rows.map((r) => r.action)).toEqual(["project.create", "team.project.attach"])
    expect(rows.every((r) => r.user_id === ROOT_ID)).toBe(true)
    expect(JSON.parse(rows[0].detail)).toMatchObject({ scope: "org", orgId: 1, projectId: "new-1", roleAfter: 700 })
    expect(JSON.parse(rows[1].detail)).toMatchObject({ scope: "team", orgId: 1, groupId: 10, projectId: "new-1" })
  })

  it("admin who is a genuine org Maintainer creates without elevation (still audited)", async () => {
    const res = await create("root", { orgId: 2, teamIds: [20] })
    expect(res.status).toBe(200)
    expect((await auditRows()).map((r) => r.action)).toEqual(["project.create", "team.project.attach"])
  })

  it("non-admins are unchanged: Maintainer and team lead create, outsider gets the original 403", async () => {
    expect((await create("mara", { orgId: 1 })).status).toBe(200)
    await sql("DELETE FROM projects WHERE id = 'new-1'")
    expect((await create("carol", { orgId: 1, teamIds: [10] })).status).toBe(200)
    await sql("DELETE FROM group_project_grants WHERE project_id = 'new-1'")
    await sql("DELETE FROM projects WHERE id = 'new-1'")

    const res = await create("outsider", { orgId: 1 })
    expect(res.status).toBe(403)
    expect(((await res.json()) as { error: string }).error).not.toMatch(/elevation/)
    expect(await auditRows()).toEqual([])
  })
})
