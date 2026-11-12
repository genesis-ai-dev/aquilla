/**
 * Platform-operator cross-tenant access — the "platform" grant path.
 *
 * WHY: platform admin (the `platform_admins` table, plus the ADMIN_EMAILS
 * bootstrap pinned to "root@example.com" in pg-test-env.ts) is the
 * support/oversight axis. A platform admin must
 * be able to open ANY org/project without holding a membership row — and that
 * access must come from the central resolvers (resolveProjectRole's
 * "platform" path, getEffectiveOrgRole), not per-route special cases, so no
 * endpoint can drift out of sync. Equally important: the path must NOT leak
 * to ordinary users, and must not displace genuine grant attribution.
 */

import { env } from "cloudflare:test"
import { describe, it, expect, afterEach } from "vitest"
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

  it("GET /projects is accessible-only so an admin's session boot is not O(all projects)", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")

    const res = await app.request("/api/v2/projects", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      projects: Array<{ id: string }>
      nextCursor: string | null
    }
    expect(body.projects).toEqual([])
    expect(body.nextCursor).toBeNull()
  })

  it("GET /projects?limit= pages the tenancy catalog for a platform admin", async () => {
    await seedForeignOrg()
    await env.AQUILLA_PG.prepare(
      "INSERT INTO projects (id, name, org_id, created_by) VALUES ('pb', 'Mark', 1, 1), ('pc', 'Acts', 1, 1)",
    ).run()
    await seedUser(7, "root")

    const first = await app.request("/api/v2/projects?limit=1", { headers: authHeader(await jwtFor("root")) }, env)
    expect(first.status).toBe(200)
    const firstBody = (await first.json()) as {
      projects: Array<{ id: string; name: string; role: { source: string } }>
      nextCursor: string | null
    }
    expect(firstBody.projects).toHaveLength(1)
    expect(firstBody.projects[0]).toMatchObject({ id: "pc", name: "Acts", role: { source: "platform" } })
    expect(firstBody.nextCursor).toBeTruthy()

    const second = await app.request(
      `/api/v2/projects?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    const secondBody = (await second.json()) as {
      projects: Array<{ id: string; name: string }>
      nextCursor: string | null
    }
    expect(secondBody.projects).toHaveLength(1)
    expect(secondBody.projects[0]).toMatchObject({ id: "pa", name: "John" })
    expect(secondBody.nextCursor).toBeTruthy()

    const search = await app.request("/api/v2/projects?q=mar", { headers: authHeader(await jwtFor("root")) }, env)
    const searchBody = (await search.json()) as { projects: Array<{ id: string; name: string }> }
    expect(searchBody.projects).toEqual([expect.objectContaining({ id: "pb", name: "Mark" })])
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

  it("GET /orgs is memberships-only so an admin's session boot is not O(all orgs)", async () => {
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
      orgs: Array<{ id: number; name: string | null; viaPlatformAdmin?: boolean }>
      nextCursor: string | null
    }
    // First entry must stay a genuine membership (the SPA defaults its active
    // org to orgs[0] — an admin's fresh session must not land in a foreign org).
    expect(body.orgs).toHaveLength(1)
    expect(body.orgs[0]).toMatchObject({ id: 2, name: "Zz root workspace" })
    expect(body.orgs[0].viaPlatformAdmin).toBeUndefined()
    expect(body.nextCursor).toBeNull()
  })

  it("GET /orgs?limit= pages foreign orgs AFTER memberships, flagged viaPlatformAdmin", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Zz root workspace', 7)",
    ).run()

    const res = await app.request("/api/v2/orgs?limit=40", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{ id: number; name: string | null; role: { level: number; name: string }; viaPlatformAdmin?: boolean }>
      nextCursor: string | null
    }
    expect(body.orgs).toHaveLength(2)
    expect(body.orgs[0]).toMatchObject({ id: 2, name: "Zz root workspace" })
    expect(body.orgs[0].viaPlatformAdmin).toBeUndefined()
    expect(body.orgs[1]).toMatchObject({ id: 1, name: "CAS", role: { level: 700, name: "admin" }, viaPlatformAdmin: true })
    expect(body.nextCursor).toBeNull()
  })

  it("GET /orgs omits a foreign org the admin already reaches via a project grant", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Zz root workspace', 7)",
    ).run()
    // Contributor grant, not org membership — this is the guest-org path.
    // Platform 700 would otherwise win role resolution and list CAS as Admin.
    await env.AQUILLA_PG.prepare(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES ('pa', 7, 400, 1)",
    ).run()

    const res = await app.request("/api/v2/orgs?limit=40", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      orgs: Array<{ id: number; name: string | null; viaPlatformAdmin?: boolean }>
    }
    expect(body.orgs.map((o) => o.id)).toEqual([2])
    expect(body.orgs[0].viaPlatformAdmin).toBeUndefined()
  })

  it("GET /orgs/:orgId hydrates a foreign org for a platform admin", async () => {
    await seedForeignOrg()
    await seedUser(7, "root")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Zz root workspace', 7)",
    ).run()

    const res = await app.request("/api/v2/orgs/1", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      id: 1,
      name: "CAS",
      role: { level: 700, name: "admin" },
      viaPlatformAdmin: true,
    })
  })

  it("GET /orgs?q= searches the catalog and paginates with cursor", async () => {
    await seedUser(7, "root")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (2, 'Root workspace', 7)",
    ).run()
    await seedUser(1, "wendi")
    await env.AQUILLA_PG.prepare(
      "INSERT INTO organizations (id, name, owner_user_id) VALUES (10, 'Alpha Org', 1), (11, 'Beta Org', 1), (12, 'Gamma Org', 1)",
    ).run()

    const first = await app.request("/api/v2/orgs?limit=1", { headers: authHeader(await jwtFor("root")) }, env)
    const firstBody = (await first.json()) as {
      orgs: Array<{ id: number; name: string | null; viaPlatformAdmin?: boolean }>
      nextCursor: string | null
    }
    // Membership + first catalog row; more remain.
    expect(firstBody.orgs[0]).toMatchObject({ id: 2, name: "Root workspace" })
    expect(firstBody.orgs[0].viaPlatformAdmin).toBeUndefined()
    expect(firstBody.orgs).toHaveLength(2)
    expect(firstBody.orgs[1].viaPlatformAdmin).toBe(true)
    expect(firstBody.nextCursor).toBeTruthy()

    const second = await app.request(
      `/api/v2/orgs?limit=1&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      { headers: authHeader(await jwtFor("root")) },
      env,
    )
    const secondBody = (await second.json()) as {
      orgs: Array<{ id: number; viaPlatformAdmin?: boolean }>
      nextCursor: string | null
    }
    expect(secondBody.orgs).toHaveLength(1)
    expect(secondBody.orgs[0].viaPlatformAdmin).toBe(true)
    expect(secondBody.orgs[0].id).not.toBe(firstBody.orgs[1].id)

    const search = await app.request("/api/v2/orgs?q=beta&limit=40", { headers: authHeader(await jwtFor("root")) }, env)
    const searchBody = (await search.json()) as { orgs: Array<{ name: string | null }> }
    expect(searchBody.orgs.map((o) => o.name)).toEqual(["Beta Org"])
  })
})

describe("GET /api/v2/admin/admins", () => {
  it("returns the env bootstrap joined to accounts; unmatched emails flagged hasAccount:false", async () => {
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

// AQU-1239: the table is the source of truth in deployed environments; the
// ADMIN_EMAILS env var is only a bootstrap. These tests turn the bootstrap off
// so that only the table can grant access.
describe("platform_admins table (AQU-1239)", () => {
  const bootstrap = env.ADMIN_EMAILS
  afterEach(() => {
    env.ADMIN_EMAILS = bootstrap
  })

  const addAdmin = (email: string, extra = "") =>
    env.AQUILLA_PG.prepare(`INSERT INTO platform_admins (email${extra ? ", note" : ""}) VALUES (?${extra ? ", ?" : ""})`)
      .bind(...(extra ? [email, extra] : [email]))
      .run()

  it("admits an account listed only in the table, matched case-insensitively, with the platform source", async () => {
    env.ADMIN_EMAILS = undefined
    await seedForeignOrg()
    await seedUser(9, "tablet")
    await env.AQUILLA_PG.prepare("UPDATE users SET email = 'Tablet@Example.COM' WHERE id = 9").run()
    await addAdmin("tablet@example.com")

    const gate = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("tablet")) }, env)
    expect(gate.status).toBe(200)

    const res = await app.request("/api/v2/projects/pa", { headers: authHeader(await jwtFor("tablet")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { role: { level: number; source: string } }
    expect(body.role).toMatchObject({ level: 700, source: "platform" })
  })

  it("revokes on the next request once the row is deleted", async () => {
    env.ADMIN_EMAILS = undefined
    await seedUser(9, "tablet")
    await addAdmin("tablet@example.com")
    const headers = authHeader(await jwtFor("tablet"))
    expect((await app.request("/api/v2/admin/me", { headers }, env)).status).toBe(200)

    await env.AQUILLA_PG.prepare("DELETE FROM platform_admins WHERE email = 'tablet@example.com'").run()
    expect((await app.request("/api/v2/admin/me", { headers }, env)).status).toBe(403)
  })

  it("403s an account that is in neither the table nor ADMIN_EMAILS", async () => {
    env.ADMIN_EMAILS = undefined
    await seedUser(9, "tablet")
    await seedUser(10, "other")
    await addAdmin("tablet@example.com")

    const res = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("other")) }, env)
    expect(res.status).toBe(403)
  })

  it("refuses rows that are not lowercase and trimmed", async () => {
    await expect(addAdmin("Mixed@Example.com")).rejects.toThrow()
    await expect(addAdmin(" padded@example.com ")).rejects.toThrow()
    await expect(addAdmin("")).rejects.toThrow()
  })

  it("GET /admins lists table rows, with and without accounts, merged with the bootstrap", async () => {
    await seedUser(7, "root") // root@example.com via ADMIN_EMAILS
    await seedUser(9, "tablet")
    await addAdmin("tablet@example.com", "support lead")
    await addAdmin("future@example.com")

    const res = await app.request("/api/v2/admin/admins", { headers: authHeader(await jwtFor("root")) }, env)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { admins: Array<Record<string, unknown>> }
    expect(body.admins.map((a) => a.email)).toEqual([
      "future@example.com",
      "root@example.com",
      "tablet@example.com",
    ])
    expect(body.admins[0]).toEqual({ email: "future@example.com", hasAccount: false })
    expect(body.admins[2]).toMatchObject({ hasAccount: true, userId: 9, username: "tablet" })
  })

  it("fails closed when the table cannot be read: table admins lose access, the env bootstrap still works, no 500", async () => {
    await seedUser(7, "root")
    await seedUser(9, "tablet")
    await addAdmin("tablet@example.com")
    await env.AQUILLA_PG.prepare("ALTER TABLE platform_admins RENAME TO platform_admins_gone").run()
    try {
      const table = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("tablet")) }, env)
      expect(table.status).toBe(403)
      const boot = await app.request("/api/v2/admin/me", { headers: authHeader(await jwtFor("root")) }, env)
      expect(boot.status).toBe(200)
    } finally {
      await env.AQUILLA_PG.prepare("ALTER TABLE platform_admins_gone RENAME TO platform_admins").run()
    }
  })
})
