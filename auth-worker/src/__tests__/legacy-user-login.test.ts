import { env } from "cloudflare:test"
import { afterEach, describe, expect, it, vi } from "vitest"
import app from "../index"
import { applyLegacyUserMigration } from "../services/legacy-user-migration"
import { hashPasswordWerkzeugScrypt } from "../utils/password"
import { orgLegacyUuidFor, projectIdFor, teamLegacyUuidFor } from "../../../src/lib/migrate/ids"

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

function d1Response(row: Record<string, unknown> | null): Response {
  return jsonResponse({
    success: true,
    result: [{ success: true, results: row ? [row] : [] }],
  })
}

async function seedAccessTargets(): Promise<void> {
  const owner = await env.AQUILLA_PG.prepare(
    `INSERT INTO users (username, email, password_hash)
     VALUES ('owner', 'owner@example.com', 'scrypt:fake$salt$hash')
     RETURNING id`,
  ).first<{ id: number }>()
  if (!owner) throw new Error("failed to seed owner")
  await env.AQUILLA_PG.prepare(
    `INSERT INTO organizations (id, name, owner_user_id, legacy_uuid)
     VALUES (10, 'Org A', ?, ?)`,
  ).bind(owner.id, orgLegacyUuidFor(10)).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO groups (id, org_id, name, created_by, legacy_uuid)
     VALUES (11, 10, 'org-a/team-a', ?, ?)`,
  ).bind(owner.id, teamLegacyUuidFor(11)).run()
  await env.AQUILLA_PG.prepare(
    `INSERT INTO projects (id, name, org_id, created_by)
     VALUES (?, 'Direct Project', 10, ?)`,
  ).bind(projectIdFor("91", "gitlab"), owner.id).run()
}

function migrationEnv() {
  return {
    ...env,
    LEGACY_USER_MIGRATION_ENABLED: "true",
    FRONTIER_D1_ACCOUNT_ID: "account",
    FRONTIER_D1_DATABASE_ID: "database",
    FRONTIER_D1_API_TOKEN: "d1-read-token",
    GITLAB_URL: "https://gitlab.example",
    GITLAB_ADMIN_TOKEN: "gitlab-admin-token",
  }
}

function installSuccessfulSourceFetch(passwordHash: string): ReturnType<typeof vi.fn> {
  const source = {
    id: 700,
    username: "Cleiton",
    email: "cleiton@example.com",
    password_hash: passwordHash,
    gitlab_user_id: 77,
    created_at: "2026-07-01 12:00:00",
    updated_at: "2026-07-02 12:00:00",
    // A real D1 row has this field. The bridge's SELECT and parser must ignore it.
    gitlab_token: "must-never-be-copied",
  }
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("api.cloudflare.com/client/v4")) {
      const request = JSON.parse(String(init?.body)) as { sql: string }
      expect(request.sql).not.toContain("gitlab_token")
      expect(init?.headers).toMatchObject({
        Authorization: "Bearer d1-read-token",
      })
      return d1Response(source)
    }
    if (url.includes("/api/v4/groups?")) {
      return jsonResponse([
        { id: 10, name: "Org A", full_path: "org-a", parent_id: null },
      ])
    }
    if (url.includes("/api/v4/groups/10/descendant_groups")) {
      return jsonResponse([
        { id: 11, name: "Team A", full_path: "org-a/team-a", parent_id: 10 },
      ])
    }
    if (url.includes("/api/v4/users/77/memberships")) {
      return jsonResponse([
        { source_type: "Namespace", source_id: 10, access_level: 40 },
        { source_type: "Namespace", source_id: 11, access_level: 50 },
        { source_type: "Project", source_id: 91, access_level: 30 },
      ])
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  global.fetch = fetchMock as typeof fetch
  return fetchMock
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe("atomic legacy-user login migration", () => {
  it("copies the exact hash and commits identity plus complete access before issuing a JWT", async () => {
    await seedAccessTargets()
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    installSuccessfulSourceFetch(passwordHash)

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "cleiton@example.com",
          password: "correct-password",
        }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ token_type: "bearer" })

    const user = await env.AQUILLA_PG.prepare(
      "SELECT id, username, email, password_hash, preferences FROM users WHERE LOWER(username) = 'cleiton'",
    ).first<{
      id: number
      username: string
      email: string
      password_hash: string
      preferences: string
    }>()
    expect(user).toMatchObject({
      username: "Cleiton",
      email: "cleiton@example.com",
      password_hash: passwordHash,
      preferences: "{}",
    })
    expect(user?.id).not.toBe(700)

    const link = await env.AQUILLA_PG.prepare(
      `SELECT source, source_user_id, neon_user_id, gitlab_user_id, imported_via
         FROM legacy_identity_links`,
    ).first<Record<string, unknown>>()
    expect(link).toMatchObject({
      source: "frontier-db-v2",
      source_user_id: 700,
      neon_user_id: user?.id,
      gitlab_user_id: 77,
      imported_via: "jit",
    })

    const orgMember = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM org_members WHERE org_id = 10 AND user_id = ?",
    ).bind(user?.id).first<{ role_level: number }>()
    expect(orgMember?.role_level).toBe(600)

    const teamMember = await env.AQUILLA_PG.prepare(
      "SELECT 1 AS present FROM group_members WHERE group_id = 11 AND user_id = ?",
    ).bind(user?.id).first<{ present: number }>()
    expect(teamMember?.present).toBe(1)

    const projectMember = await env.AQUILLA_PG.prepare(
      "SELECT role_level FROM project_members WHERE project_id = ? AND user_id = ?",
    ).bind(projectIdFor("91", "gitlab"), user?.id).first<{ role_level: number }>()
    expect(projectMember?.role_level).toBe(400)
  })

  it("does not call D1 or accept a legacy credential when a Neon identity exists", async () => {
    const neonHash = await hashPasswordWerkzeugScrypt("neon-password")
    await env.AQUILLA_PG.prepare(
      `INSERT INTO users (username, email, password_hash)
       VALUES ('Cleiton', 'cleiton@example.com', ?)`,
    ).bind(neonHash).run()
    const fetchMock = vi.fn()
    global.fetch = fetchMock as typeof fetch

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "cleiton", password: "legacy-password" }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("wrong legacy password creates no Neon state and never queries GitLab", async () => {
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    const sourceFetch = installSuccessfulSourceFetch(passwordHash)

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Cleiton", password: "wrong-password" }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(401)
    expect(sourceFetch).toHaveBeenCalledTimes(1)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).first<number>("n")).toBe(0)
  })

  it("quarantines a legacy username/email collision before GitLab or Neon writes", async () => {
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    const source = {
      id: 700,
      username: "Cleiton",
      email: "shared@example.com",
      password_hash: passwordHash,
      gitlab_user_id: 77,
      created_at: null,
      updated_at: null,
    }
    const split = {
      ...source,
      id: 701,
      username: "OtherUser",
      gitlab_user_id: 78,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (!url.includes("api.cloudflare.com/client/v4")) {
        throw new Error(`GitLab must not be queried for a conflicted identity: ${url}`)
      }
      const request = JSON.parse(String(init?.body)) as { params: string[] }
      const identifier = request.params[0]?.toLowerCase()
      if (identifier === "cleiton") return d1Response(source)
      if (identifier === "shared@example.com") {
        return jsonResponse({
          success: true,
          result: [{ success: true, results: [source, split] }],
        })
      }
      throw new Error(`unexpected D1 identifier: ${identifier}`)
    })
    global.fetch = fetchMock as typeof fetch

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: "Cleiton",
          password: "correct-password",
        }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(409)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).first<number>("n")).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("a GitLab failure rolls back the entire migration", async () => {
    await seedAccessTargets()
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    const source = {
      id: 700,
      username: "Cleiton",
      email: "cleiton@example.com",
      password_hash: passwordHash,
      gitlab_user_id: 77,
      created_at: null,
      updated_at: null,
    }
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("api.cloudflare.com/client/v4")) return d1Response(source)
      return jsonResponse({ message: "down" }, 503)
    }) as typeof fetch

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Cleiton", password: "correct-password" }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(503)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE LOWER(username) = 'cleiton'",
    ).first<number>("n")).toBe(0)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM legacy_identity_links",
    ).first<number>("n")).toBe(0)
  })

  it("missing Aquilla access targets create no partial user", async () => {
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    installSuccessfulSourceFetch(passwordHash)

    const response = await app.request(
      "/api/v2/auth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Cleiton", password: "correct-password" }),
      },
      migrationEnv(),
    )

    expect(response.status).toBe(503)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users",
    ).first<number>("n")).toBe(0)
  })

  it("rolls back identity and earlier memberships when a target disappears mid-transaction", async () => {
    await seedAccessTargets()
    const passwordHash = await hashPasswordWerkzeugScrypt("correct-password")
    const source = {
      id: 701,
      username: "AtomicUser",
      email: "atomic@example.com",
      password_hash: passwordHash,
      gitlab_user_id: 78,
      created_at: null,
      updated_at: null,
    }

    await expect(applyLegacyUserMigration(env.AQUILLA_PG, source, {
      orgMemberships: [{ orgUuid: orgLegacyUuidFor(10), roleLevel: 400 }],
      // This target was present when a hypothetical access plan was prepared,
      // but is absent when the transaction validates it.
      teamUuids: [teamLegacyUuidFor(999)],
      projectMemberships: [],
      conflicts: [],
      confirmedMembershipCount: 1,
    }, "jit")).rejects.toMatchObject({ code: "dependency" })

    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE LOWER(username) = 'atomicuser'",
    ).first<number>("n")).toBe(0)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM legacy_identity_links WHERE source_user_id = 701",
    ).first<number>("n")).toBe(0)
    expect(await env.AQUILLA_PG.prepare(
      "SELECT COUNT(*) AS n FROM org_members WHERE user_id NOT IN (SELECT id FROM users)",
    ).first<number>("n")).toBe(0)
  })
})
