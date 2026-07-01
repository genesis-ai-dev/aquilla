/**
 * Platform-operator cross-tenant access — the "platform" grant path.
 *
 * WHY: ADMIN_EMAILS (deploy-config allowlist, pinned to "root@example.com" in
 * pg-test-env.ts) is the support/oversight axis. An allowlisted operator must
 * be able to open ANY org/project without holding a membership row — and that
 * access must come from the central resolvers (resolveProjectRole's
 * "platform" path, getEffectiveOrgRole), not per-route special cases, so no
 * endpoint can drift out of sync. Equally important: the path must NOT leak
 * to ordinary users, and must not displace genuine grant attribution.
 */

import { env } from "cloudflare:test"
import { describe, it, expect } from "vitest"
import app from "../index"
import { seedUser, jwtFor, authHeader } from "./helpers/db"

/** Foreign tenancy the admin has NO membership in: org 1 + project owned by wendi. */
async function seedForeignOrg() {
  await seedUser(1, "wendi")
  await env.AQUILLA_PG.prepare(
    "INSERT INTO organizations (id, name, owner_user_id) VALUES (1, 'CAS', 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (1, 1, 700, 1)",
  ).run()
  await env.AQUILLA_PG.prepare(
    "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pa', 'John', 1, 1)",
  ).run()
}

describe("platform-admin cross-tenant access", () => {
  it("resolves owner-level on a foreign project (source: platform)", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")

    const res = await app.request("/api/v2/projects/pa", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 700, source: "platform" })
  })

  it("does NOT grant project access to a non-allowlisted outsider", async () => {
    await seedForeignOrg()
    await seedUser(8, "mallory")

    const res = await app.request("/api/v2/projects/pa", { headers: authHeader(await jwtFor("mallory")) }, env)
    expect(res.status).toBe(403)
  })

  it("keeps genuine grant attribution when the admin is also a real member", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    // root holds a real owner-level direct grant — "override" must win the tie.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 7, 700, 1)",
    ).run()

    const res = await app.request("/api/v2/projects/pa", { headers: authHeader(await jwtFor("root")) }, env)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 700, source: "override" })
  })

  it("lists foreign projects in GET /projects with the platform role", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")

    const res = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { projects: Array<{ id: string; role: { level: number; source: string } }> }
    expect(body.projects).toHaveLength(1)
    expect(body.projects[0]).toMatchObject({ id: "pa", role: { level: 700, source: "platform" } })

    // The bypass must not widen what an ordinary outsider sees.
    await seedUser(8, "mallory")
    const denied = await app.request("/api/v2/projects?orgId=1", { headers: authHeader(await jwtFor("mallory")) }, env)
    expect(((await denied.json()) as { projects: unknown[] }).projects).toHaveLength(0)
  })

  it("passes org-route guards on a foreign org (portfolio) but not for outsiders", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    await seedUser(8, "mallory")

    const ok = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("root")) }, env)
    expect(ok.status).toBe(200)

    const denied = await app.request("/api/v2/orgs/1/portfolio", { headers: authHeader(await jwtFor("mallory")) }, env)
    expect(denied.status).toBe(403)
  })

  it("GET /orgs appends foreign orgs AFTER genuine memberships, flagged viaPlatformAdmin", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    // Explicit personal org (explicit-id seeds don't advance the serial
    // sequence, so letting the route lazy-create would collide with org 1).
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Zz root workspace', 7)",
    ).run()

    const res = await app.request("/api/v2/orgs", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{ id: number; name: string | null; role: { level: number; name: string }; viaPlatformAdmin?: boolean }>
    }
    // First entry must stay a genuine membership even though "CAS" sorts
    // before "Zz root workspace" (the SPA defaults its active org to orgs[0]
    // — an admin's fresh session must not land in a foreign org).
    expect(body.orgs).toHaveLength(2)
    expect(body.orgs[0]).toMatchObject({ id: 2, name: "Zz root workspace" })
    expect(body.orgs[0].viaPlatformAdmin).toBeUndefined()
    expect(body.orgs[1]).toMatchObject({ id: 1, name: "CAS", role: { level: 700, name: "admin" }, viaPlatformAdmin: true })
  })
})

describe("GET /api/v2/admin/admins", () => {
  it("returns the email allowlist joined to accounts; unmatched emails flagged hasAccount:false", async () => {
    // Test env allowlist is exactly "root@example.com". Seed root so it matches.
    await seedUser(7, "root")

    const res = await app.request("/api/v2/admin/admins", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { admins: Array<Record<string, unknown>> }
    expect(body.admins).toHaveLength(1)
    expect(body.admins[0]).toMatchObject({
      email: "root@example.com",
      hasAccount: true,
      userId: 7,
      username: "root",
    })
  })

  it("is gated — a non-admin gets 403", async () => {
    await seedUser(1, "wendi")
    const res = await app.request("/api/v2/admin/admins", { headers: authHeader(await jwtFor("wendi")) }, env)
    expect(res.status).toBe(403)
  })
})
