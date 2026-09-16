import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"
import { validateApiCredential } from "../../../db/shared/api-credentials"
const client_id = "aquilla-agent"
const grant_type = "urn:ietf:params:oauth:grant-type:device_code"
async function post(path: string, data: object, jwt?: string) {
  return app.request(`/api/v2/agent-connect/${path}`, { method: "POST",
    headers: jwt ? authHeader(jwt) : { "Content-Type": "application/json" },
    body: JSON.stringify(data) }, env)
}
async function start(scope = "ask", project_id?: string) {
  const response = await post("device_authorization", { client_id, agent_name: "Test agent", scope, project_id })
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  return await response.json() as { device_code: string; user_code: string; verification_uri_complete: string }
}
const poll = (device_code: string) => post("token", { client_id, grant_type, device_code })
async function seed() {
  await seedUser(1, "alice"); await seedUser(2, "bob")
  await env.AQUILLA_PG.prepare("INSERT INTO projects (id, name, created_by) VALUES ('p', 'Project', 1)").run()
  return jwtFor("alice")
}
const approve = (user_code: string, jwt: string, project_id = "p") => post("decision", {
  user_code, approve: true, code_confirmed: true, project_id,
}, jwt)
describe("browser authorization → existing credential consumer", () => {
  it("delivers one scoped expiring credential to the agent, revocable through existing controls", async () => {
    const jwt = await seed(); const request = await start()
    expect(request.verification_uri_complete).toContain("/connect-agent#user_code=")
    expect(request.verification_uri_complete).not.toContain(request.device_code)
    expect(await (await post("request", { user_code: request.user_code }, jwt)).json()).toMatchObject({ agentName: "Test agent", mode: "ask" })
    expect(await (await approve(request.user_code, jwt)).json()).toEqual({ status: "approved" })
    const response = await poll(request.device_code)
    expect(response.status).toBe(200)
    const token = await response.json() as { access_token: string; credential_id: string; expires_in: number }
    expect(token.expires_in).toBe(2592000)
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token)).toMatchObject({ userId: "1", mode: "ask", projectId: "p" })
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "expired_token" })
    const rows = JSON.stringify(await env.AQUILLA_PG.prepare("SELECT * FROM agent_authorizations").all())
    for (const secret of [request.device_code, request.user_code, token.access_token]) expect(rows).not.toContain(secret)
    const revoked = await app.request(`/api/v2/credentials/${token.credential_id}`, { method: "DELETE", headers: authHeader(jwt) }, env)
    expect(revoked.status).toBe(200)
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token)).toBeNull()
  })
  it("enforces pending and polling slowdown", async () => {
    const request = await start()
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "authorization_pending" })
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "slow_down" })
    expect(await env.AQUILLA_PG.prepare("SELECT poll_interval FROM agent_authorizations").first()).toEqual({ poll_interval: 10 })
  })
  it("denial is terminal", async () => {
    const jwt = await seed(); const request = await start()
    expect((await post("decision", { user_code: request.user_code, approve: false }, jwt)).status).toBe(200)
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "access_denied" })
    expect((await approve(request.user_code, jwt)).status).toBe(400)
  })
  it("rejects expired consent and redemption", async () => {
    const jwt = await seed(); const request = await start()
    await env.AQUILLA_PG.prepare("UPDATE agent_authorizations SET expires_at = now() - interval '1 second'").run()
    expect((await approve(request.user_code, jwt)).status).toBe(400)
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "expired_token" })
  })
  it("requires login, code confirmation, current permission and the requested project", async () => {
    const jwt = await seed(); const request = await start("act", "p")
    expect((await approve(request.user_code, "invalid")).status).toBe(401)
    expect((await post("decision", { user_code: request.user_code, approve: true, project_id: "p" }, jwt)).status).toBe(400)
    expect((await approve(request.user_code, await jwtFor("bob"))).status).toBe(403)
    expect((await approve(request.user_code, jwt, "different")).status).toBe(403)
    expect((await approve(request.user_code, jwt)).status).toBe(200)
    await env.AQUILLA_PG.prepare("UPDATE projects SET archived_at = now() WHERE id = 'p'").run()
    expect(await (await poll(request.device_code)).json()).toEqual({ error: "access_denied" })
  })
  it("concurrent redemption creates at most one credential", async () => {
    const jwt = await seed(); const request = await start(); await approve(request.user_code, jwt)
    const responses = await Promise.all([poll(request.device_code), poll(request.device_code)])
    expect(responses.filter(r => r.status === 200)).toHaveLength(1)
    expect(await env.AQUILLA_PG.prepare("SELECT count(*)::int AS n FROM api_credentials").first()).toEqual({ n: 1 })
  })
  it("requires maintainer for act mode and throttles public initiation", async () => {
    await seed()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p', 2, 400, 1)").run()
    const bob = await jwtFor("bob")
    const act = await start("act", "p")
    expect((await approve(act.user_code, bob)).status).toBe(403)
    const ask = await start("ask", "p")
    expect((await approve(ask.user_code, bob)).status).toBe(200)
    await env.AQUILLA_PG.prepare("INSERT INTO auth_rate_limit_events (kind, identifier, success) SELECT 'agent_authorize', 'ip:local', 1 FROM generate_series(1, 20)").run()
    expect((await post("device_authorization", { client_id, agent_name: "CLI" })).status).toBe(429)
  })
  it("rejects code lookup without a browser session", async () => {
    const grant = await start()
    expect((await post("request", { user_code: grant.user_code })).status).toBe(401)
    expect((await post("decision", { user_code: grant.user_code, approve: true, project_id: "p", code_confirmed: true })).status).toBe(401)
  })
  it("mints the mode the human granted, not the one the agent asked for", async () => {
    // The consent screen is the authority on autonomy: an agent that asked for
    // ask must be grantable act, and an agent that asked for act must be
    // downgradable, without either re-running the flow.
    const jwt = await seed(); const request = await start("ask")
    expect((await post("decision", { user_code: request.user_code, approve: true,
      code_confirmed: true, project_id: "p", mode: "act" }, jwt)).status).toBe(200)
    const token = await (await poll(request.device_code)).json() as { access_token: string; scope: string }
    expect(token.scope).toBe("act")
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token)).toMatchObject({ mode: "act", projectId: "p" })
  })
  it("checks the granted mode's floor, not the requested mode's", async () => {
    // Bob is a contributor: enough for ask, never enough for act — including
    // when the agent politely asked for ask and Bob reaches for act.
    await seed()
    await env.AQUILLA_PG.prepare("INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('p', 2, 400, 1)").run()
    const bob = await jwtFor("bob"); const request = await start("ask")
    expect((await post("decision", { user_code: request.user_code, approve: true,
      code_confirmed: true, project_id: "p", mode: "act" }, bob)).status).toBe(403)
    expect((await post("decision", { user_code: request.user_code, approve: true,
      code_confirmed: true, project_id: "p", mode: "ask" }, bob)).status).toBe(200)
  })
  it("grants org scope when the agent pinned nothing", async () => {
    await seedUser(1, "alice")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    const jwt = await jwtFor("alice"); const request = await start("act")
    expect((await post("decision", { user_code: request.user_code, approve: true,
      code_confirmed: true, org_id: "1", mode: "act" }, jwt)).status).toBe(200)
    const token = await (await poll(request.device_code)).json() as { access_token: string; org_id: string; project_id: string | null }
    expect(token).toMatchObject({ org_id: "1", project_id: null })
    expect(await validateApiCredential(env.AQUILLA_PG, token.access_token)).toMatchObject({ mode: "act", orgId: "1" })
  })
  it("refuses org scope below the mode's floor", async () => {
    await seedUser(1, "alice"); await seedUser(2, "bob")
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 2, 400, 1)").run()
    const bob = await jwtFor("bob")
    const act = await start("act")
    expect((await post("decision", { user_code: act.user_code, approve: true, code_confirmed: true, org_id: "1" }, bob)).status).toBe(403)
    const ask = await start("ask")
    expect((await post("decision", { user_code: ask.user_code, approve: true, code_confirmed: true, org_id: "1" }, bob)).status).toBe(200)
  })
  it("keeps a requested project pinned and takes exactly one scope", async () => {
    // The pin is the agent's guarantee that approval means what it asked for;
    // silently widening it to the whole org would grant beyond what was shown.
    const jwt = await seed()
    await env.AQUILLA_PG.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'Come and See', 1)").run()
    await env.AQUILLA_PG.prepare("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)").run()
    const pinned = await start("ask", "p")
    expect((await post("decision", { user_code: pinned.user_code, approve: true, code_confirmed: true, org_id: "1" }, jwt)).status).toBe(403)
    const open = await start("ask")
    // Neither scope, and both scopes, are equally malformed.
    expect((await post("decision", { user_code: open.user_code, approve: true, code_confirmed: true }, jwt)).status).toBe(400)
    expect((await post("decision", { user_code: open.user_code, approve: true, code_confirmed: true, org_id: "1", project_id: "p" }, jwt)).status).toBe(400)
  })
  it("supports form requests and rejects unknown client IDs", async () => {
    const response = await app.request("/api/v2/agent-connect/device_authorization", { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id, agent_name: "CLI" }).toString() }, env)
    expect(response.status).toBe(200)
    expect((await post("device_authorization", { client_id: "unknown", agent_name: "CLI" })).status).toBe(400)
  })
})
