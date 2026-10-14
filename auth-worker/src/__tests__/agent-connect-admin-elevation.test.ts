// [Pen test] Authorization & access control (2026-10-13): the device-flow
// approval must not turn un-elevated platform-admin power into a permanent
// (never-expiring) agent credential. Same rule as credential minting (OPS-44).
// ADMIN_EMAILS=root@example.com in the test env, so "root" is the platform admin.

import { env } from "cloudflare:test"
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

const CLIENT_ID = "aquilla-agent"

const post = (path: string, data: object, jwt?: string) =>
  app.request(
    `/api/v2/agent-connect/${path}`,
    { method: "POST", headers: jwt ? authHeader(jwt) : { "Content-Type": "application/json" }, body: JSON.stringify(data) },
    env,
  )

async function startFlow(): Promise<string> {
  const res = await post("device_authorization", { client_id: CLIENT_ID, agent_name: "Test agent", scope: "ask" })
  return ((await res.json()) as { user_code: string }).user_code
}

const decide = (userCode: string, jwt: string, scope: { project_id?: string; org_id?: string }) =>
  post("decision", { user_code: userCode, approve: true, code_confirmed: true, ...scope }, jwt)

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

beforeEach(async () => {
  env.ADMIN_REQUIRE_ELEVATION = "true"
  await seedUser(1, "owner")
  await seedUser(7, "root")
  await seedUser(8, "member")
  await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Tenant', 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, org_id, created_by) VALUES ('p', 'P', 1, 1)").run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p', 8, 400, 1)",
  ).run()
})

afterEach(() => {
  env.ADMIN_REQUIRE_ELEVATION = undefined
})

describe("agent-connect decision vs. un-elevated platform admin", () => {
  it("refuses a project approval resting only on admin power", async () => {
    const res = await decide(await startFlow(), await jwtFor("root"), { project_id: "p" })
    expect(res.status).toBe(403)
  })

  it("refuses an org approval resting only on admin power", async () => {
    const res = await decide(await startFlow(), await jwtFor("root"), { org_id: "1" })
    expect(res.status).toBe(403)
  })

  it("allows the same approval once the admin has elevated", async () => {
    const jwt = await jwtFor("root")
    await elevate(jwt)
    const res = await decide(await startFlow(), jwt, { project_id: "p" })
    expect(res.status).toBe(200)
  })

  it("is unchanged for a genuine member", async () => {
    const res = await decide(await startFlow(), await jwtFor("member"), { project_id: "p" })
    expect(res.status).toBe(200)
  })
})
