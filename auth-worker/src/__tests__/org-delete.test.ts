import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

async function seedOrg() {
  await seedUser(1, "wendi")
  await seedUser(2, "tom")
  await seedUser(3, "root")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (1, 'Accidental', 1, 'team'), (2, 'Kept', 2, 'team')",
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES
       (1, 1, 700, 1),
       (1, 2, 600, 1),
       (2, 2, 700, 2)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO groups (id, org_id, name, created_by) VALUES (10, 1, 'WA', 1), (20, 2, 'Keepers', 2)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO group_members (group_id, user_id, added_by) VALUES (10, 2, 1), (20, 2, 2)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_invites (token, org_id, role_level, created_by) VALUES ('invite-token-1', 1, 400, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_settings (org_id, settings) VALUES (1, '{}')",
  ).run()
  await env.AQUILLA_PG.prepare("INSERT INTO org_billing (org_id) VALUES (1)").run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO api_credentials (id, user_id, name, token_prefix, token_hash, mode, org_id) VALUES
       ('11111111-1111-4111-8111-111111111111', '1', 'org pat', 'aqk_org1', 'hash-org-1', 'ask', '1'),
       ('22222222-2222-4222-8222-222222222222', '1', 'other pat', 'aqk_org2', 'hash-org-2', 'ask', '2'),
       ('33333333-3333-4333-8333-333333333333', '1', 'user pat', 'aqk_user', 'hash-user', 'ask', NULL)`,
  ).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO agent_authorizations
       (device_hash, user_code_hash, client_id, agent_name, mode, org_id, expires_at)
     VALUES
       ('device-1', 'code-1', 'client', 'importer', 'ask', '1', now() + interval '1 day'),
       ('device-2', 'code-2', 'client', 'importer', 'ask', '2', now() + interval '1 day')`,
  ).run()
}

describe("DELETE /api/v2/orgs/:orgId", () => {
  it("lets the owner delete an empty org and cleans dependent rows", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", {
      method: "DELETE",
      headers: authHeader(await jwtFor("wendi")),
    }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ removed: true })

    const org = await env.AQUILLA_PG.prepare("SELECT id FROM organizations WHERE id = 1").first()
    expect(org).toBeNull()
    const kept = await env.AQUILLA_PG.prepare("SELECT name FROM organizations WHERE id = 2").first<{ name: string }>()
    expect(kept?.name).toBe("Kept")

    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM org_members WHERE org_id = 1").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM org_members WHERE org_id = 2").first()).not.toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM groups WHERE org_id = 1").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM group_members WHERE group_id = 10").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT name FROM groups WHERE id = 20").first<{ name: string }>()).toMatchObject({ name: "Keepers" })
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM org_invites WHERE token = 'invite-token-1'").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM org_settings WHERE org_id = 1").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM org_billing WHERE org_id = 1").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM api_credentials WHERE token_hash = 'hash-org-1'").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM api_credentials WHERE token_hash = 'hash-org-2'").first()).not.toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM api_credentials WHERE token_hash = 'hash-user'").first()).not.toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM agent_authorizations WHERE device_hash = 'device-1'").first()).toBeNull()
    expect(await env.AQUILLA_PG.prepare("SELECT 1 AS ok FROM agent_authorizations WHERE device_hash = 'device-2'").first()).not.toBeNull()

    const preview = await app.request("/api/v2/orgs/invite-preview/invite-token-1", { method: "GET" }, env)
    expect(preview.status).toBe(404)

    const listed = await app.request("/api/v2/orgs", {
      method: "GET",
      headers: authHeader(await jwtFor("tom")),
    }, env)
    expect(listed.status).toBe(200)
    const body = await listed.json() as { orgs: Array<{ id: number }> }
    expect(body.orgs.map((org) => org.id)).not.toContain(1)
    expect(body.orgs.map((org) => org.id)).toContain(2)
  })

  it("returns 403 for a maintainer, a non-member, and a platform admin who is not the owner", async () => {
    await seedOrg()
    const maintainer = await app.request("/api/v2/orgs/1", {
      method: "DELETE",
      headers: authHeader(await jwtFor("tom")),
    }, env)
    expect(maintainer.status).toBe(403)

    await seedUser(4, "stranger")
    const stranger = await app.request("/api/v2/orgs/1", {
      method: "DELETE",
      headers: authHeader(await jwtFor("stranger")),
    }, env)
    expect(stranger.status).toBe(403)

    const platform = await app.request("/api/v2/orgs/1", {
      method: "DELETE",
      headers: authHeader(await jwtFor("root")),
    }, env)
    expect(platform.status).toBe(403)

    const still = await env.AQUILLA_PG.prepare("SELECT name FROM organizations WHERE id = 1").first<{ name: string }>()
    expect(still?.name).toBe("Accidental")
  })

  it("returns 404 for an unknown org and 400 for a bad id", async () => {
    await seedUser(1, "wendi")
    const missing = await app.request("/api/v2/orgs/99", {
      method: "DELETE",
      headers: authHeader(await jwtFor("wendi")),
    }, env)
    expect(missing.status).toBe(404)
    const bad = await app.request("/api/v2/orgs/nope", {
      method: "DELETE",
      headers: authHeader(await jwtFor("wendi")),
    }, env)
    expect(bad.status).toBe(400)
  })

  it("returns 409 while any project row remains, including an archived one", async () => {
    await seedOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES ('p-archived', 'Ruth', 1, 1, now())",
    ).run()
    const res = await app.request("/api/v2/orgs/1", {
      method: "DELETE",
      headers: authHeader(await jwtFor("wendi")),
    }, env)
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string; projectCount: number }
    expect(body.error).toBe("organization_has_projects")
    expect(body.projectCount).toBe(1)
    const org = await env.AQUILLA_PG.prepare("SELECT id FROM organizations WHERE id = 1").first()
    expect(org).not.toBeNull()
    const invite = await env.AQUILLA_PG.prepare("SELECT token FROM org_invites WHERE token = 'invite-token-1'").first()
    expect(invite).not.toBeNull()
  })

  it("recreates a personal workspace after the caller deletes their last org", async () => {
    await seedUser(1, "kume")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (7, 'kume''s workspace', 1, 'personal')",
    ).run()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (7, 1, 700, 1)",
    ).run()
    const deleted = await app.request("/api/v2/orgs/7", {
      method: "DELETE",
      headers: authHeader(await jwtFor("kume")),
    }, env)
    expect(deleted.status).toBe(200)

    const listed = await app.request("/api/v2/orgs", {
      method: "GET",
      headers: authHeader(await jwtFor("kume")),
    }, env)
    const body = await listed.json() as { orgs: Array<{ id: number; name: string | null }> }
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0].id).not.toBe(7)
    expect(body.orgs[0].name).toBe("kume's workspace")
  })

  it("still renames for a maintainer", async () => {
    await seedOrg()
    const res = await app.request("/api/v2/orgs/1", {
      method: "PATCH",
      headers: authHeader(await jwtFor("tom")),
      body: JSON.stringify({ name: "Renamed" }),
    }, env)
    expect(res.status).toBe(200)
    const row = await env.AQUILLA_PG.prepare("SELECT name FROM organizations WHERE id = 1").first<{ name: string }>()
    expect(row?.name).toBe("Renamed")
  })
})
