// AQU-1322: membership changes made by a platform admin land in admin_audit_log.
//
// The base test allowlist is ADMIN_EMAILS=root@example.com (pg-test-env), so the
// seeded "root" user is the platform admin. "owner" is a genuine org owner and
// must produce no audit rows through the very same routes.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const ROOT_ID = 7
const OWNER_ID = 1
const ALICE_ID = 2
const BOB_ID = 3

beforeEach(async () => {
  await seedUser(OWNER_ID, "owner")
  await seedUser(ALICE_ID, "alice")
  await seedUser(BOB_ID, "bob")
  await seedUser(ROOT_ID, "root")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'PartnerOrg', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('proj-a', 'ProjA', 1, 1)",
  ).run()
})

type AuditRow = { user_id: number; action: string; detail: string }
type Detail = {
  action: string
  actor: { userId: number; username: string }
  target: { userId: number; username: string | null }
  scope: "org" | "project"
  orgId: number | null
  groupId: number | null
  projectId: string | null
  roleBefore: number | null
  roleAfter: number | null
}

const auditRows = async (): Promise<AuditRow[]> => {
  const res = await env.AQUILLA_PG.prepare(
    "SELECT user_id, action, detail FROM admin_audit_log WHERE action LIKE 'org.member.%' OR action LIKE 'project.member.%' ORDER BY id",
  ).all<AuditRow>()
  return res.results ?? []
}
const detailOf = (row: AuditRow): Detail => JSON.parse(row.detail) as Detail

const call = async (as: string, method: string, path: string, body?: unknown) =>
  app.request(
    path,
    {
      method,
      headers: authHeader(await jwtFor(as)),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
  )

describe("org membership by a platform admin", () => {
  it("writes one row per add, role change, and remove", async () => {
    const add = await call("root", "POST", "/api/v2/orgs/1/members", { username: "alice", role: 200 })
    expect(add.status).toBe(200)
    let rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe("org.member.add")
    expect(rows[0].user_id).toBe(ROOT_ID)
    expect(detailOf(rows[0])).toEqual({
      action: "org.member.add",
      actor: { userId: ROOT_ID, username: "root" },
      target: { userId: ALICE_ID, username: "alice" },
      scope: "org",
      orgId: 1,
      groupId: null,
      projectId: null,
      roleBefore: null,
      roleAfter: 200,
    })

    const change = await call("root", "POST", "/api/v2/orgs/1/members", { username: "alice", role: 400 })
    expect(change.status).toBe(200)
    rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].action).toBe("org.member.role")
    expect(detailOf(rows[1])).toMatchObject({ roleBefore: 200, roleAfter: 400, orgId: 1 })

    const remove = await call("root", "DELETE", `/api/v2/orgs/1/members/${ALICE_ID}`)
    expect(remove.status).toBe(200)
    rows = await auditRows()
    expect(rows).toHaveLength(3)
    expect(rows[2].action).toBe("org.member.remove")
    expect(detailOf(rows[2])).toMatchObject({
      target: { userId: ALICE_ID, username: "alice" },
      roleBefore: 400,
      roleAfter: null,
      scope: "org",
    })
  })

  it("writes one row per successful person in a batch and none for failures", async () => {
    const res = await call("root", "POST", "/api/v2/orgs/1/members", {
      members: [
        { username: "alice", role: 200 },
        { username: "ghost", role: 200 },
        { username: "bob", role: 300 },
      ],
    })
    expect(res.status).toBe(200)
    const rows = await auditRows()
    expect(rows.map((r) => detailOf(r).target.username)).toEqual(["alice", "bob"])
  })

  it("writes nothing when the request fails", async () => {
    const res = await call("root", "POST", "/api/v2/orgs/1/members", { username: "ghost", role: 200 })
    expect(res.status).toBe(404)
    expect(await auditRows()).toHaveLength(0)
  })

  it("writes nothing when a non-owner, non-admin is denied", async () => {
    const res = await call("alice", "POST", "/api/v2/orgs/1/members", { username: "bob", role: 200 })
    expect(res.status).toBe(403)
    expect(await auditRows()).toHaveLength(0)
  })
})

describe("org membership by a genuine owner", () => {
  it("writes no audit rows and keeps the same responses", async () => {
    const add = await call("owner", "POST", "/api/v2/orgs/1/members", { username: "alice", role: 200 })
    expect(add.status).toBe(200)
    expect(await add.json()).toEqual({ userId: ALICE_ID, username: "alice", role: { level: 200, name: "commenter" } })

    const change = await call("owner", "POST", "/api/v2/orgs/1/members", { username: "alice", role: 400 })
    expect(change.status).toBe(200)

    const remove = await call("owner", "DELETE", `/api/v2/orgs/1/members/${ALICE_ID}`)
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ removed: true })

    expect(await auditRows()).toHaveLength(0)
  })
})

describe("project membership by a platform admin", () => {
  it("writes one row per grant, role change, and remove", async () => {
    const grant = await call("root", "POST", "/api/v2/projects/proj-a/members", { username: "alice", role: 300 })
    expect(grant.status).toBe(200)
    let rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe("project.member.grant")
    expect(detailOf(rows[0])).toEqual({
      action: "project.member.grant",
      actor: { userId: ROOT_ID, username: "root" },
      target: { userId: ALICE_ID, username: "alice" },
      scope: "project",
      orgId: null,
      groupId: null,
      projectId: "proj-a",
      roleBefore: null,
      roleAfter: 300,
    })

    const change = await call("root", "POST", "/api/v2/projects/proj-a/members", { username: "alice", role: 400 })
    expect(change.status).toBe(200)
    rows = await auditRows()
    expect(rows).toHaveLength(2)
    expect(rows[1].action).toBe("project.member.role")
    expect(detailOf(rows[1])).toMatchObject({ roleBefore: 300, roleAfter: 400 })

    const remove = await call("root", "DELETE", `/api/v2/projects/proj-a/members/${ALICE_ID}`)
    expect(remove.status).toBe(200)
    rows = await auditRows()
    expect(rows).toHaveLength(3)
    expect(rows[2].action).toBe("project.member.remove")
    expect(detailOf(rows[2])).toMatchObject({
      target: { userId: ALICE_ID, username: "alice" },
      roleBefore: 400,
      roleAfter: null,
      projectId: "proj-a",
    })
  })

  it("writes one row per successful person in a batch and none for failures", async () => {
    const res = await call("root", "POST", "/api/v2/projects/proj-a/members", {
      members: [
        { username: "alice", role: 300 },
        { username: "ghost", role: 300 },
        { username: "bob", role: 400 },
      ],
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: Array<{ username: string; ok: boolean }> }
    expect(body.results.map((r) => r.ok)).toEqual([true, false, true])
    const rows = await auditRows()
    expect(rows.map((r) => detailOf(r).target.username)).toEqual(["alice", "bob"])
  })

  it("writes one row for revoke-all, and none when there is no direct row", async () => {
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('proj-a', 2, 300, 1)",
    ).run()
    const revoke = await call("root", "POST", `/api/v2/projects/proj-a/members/${ALICE_ID}/revoke-all`)
    expect(revoke.status).toBe(200)
    const rows = await auditRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe("project.member.revoke_all")
    expect(detailOf(rows[0])).toMatchObject({
      target: { userId: ALICE_ID, username: "alice" },
      roleBefore: 300,
      roleAfter: null,
    })

    const again = await call("root", "POST", `/api/v2/projects/proj-a/members/${ALICE_ID}/revoke-all`)
    expect(again.status).toBe(200)
    expect(await auditRows()).toHaveLength(1)
  })

  it("writes nothing for a denied or failed request", async () => {
    const unknown = await call("root", "POST", "/api/v2/projects/proj-a/members", { username: "ghost", role: 300 })
    expect(unknown.status).toBe(404)
    const noRow = await call("root", "DELETE", `/api/v2/projects/proj-a/members/${BOB_ID}`)
    expect(noRow.status).toBe(409)
    const denied = await call("alice", "POST", "/api/v2/projects/proj-a/members", { username: "bob", role: 300 })
    expect(denied.status).toBe(403)
    expect(await auditRows()).toHaveLength(0)
  })
})

describe("project membership by a genuine non-admin owner", () => {
  it("writes no audit rows and keeps the same responses", async () => {
    const grant = await call("owner", "POST", "/api/v2/projects/proj-a/members", { username: "alice", role: 300 })
    expect(grant.status).toBe(200)
    expect(await grant.json()).toEqual({
      userId: ALICE_ID,
      username: "alice",
      role: { level: 300, name: "reviewer", source: "override" },
    })

    const batch = await call("owner", "POST", "/api/v2/projects/proj-a/members", {
      members: [
        { username: "bob", role: 400 },
        { username: "ghost", role: 400 },
      ],
    })
    expect(batch.status).toBe(200)
    expect(await batch.json()).toEqual({
      results: [
        { username: "bob", ok: true },
        { username: "ghost", ok: false, error: { code: "user_not_found", message: "user not found" } },
      ],
    })

    const revoke = await call("owner", "POST", `/api/v2/projects/proj-a/members/${BOB_ID}/revoke-all`)
    expect(revoke.status).toBe(200)
    const remove = await call("owner", "DELETE", `/api/v2/projects/proj-a/members/${ALICE_ID}`)
    expect(remove.status).toBe(200)
    expect(await remove.json()).toEqual({ removed: true })

    expect(await auditRows()).toHaveLength(0)
  })
})
