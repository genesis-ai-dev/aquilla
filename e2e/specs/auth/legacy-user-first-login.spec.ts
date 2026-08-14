import { expect, test } from "@playwright/test"
import { Client } from "pg"
import { resetBackend } from "../../helpers/seed"
import {
  orgLegacyUuidFor,
  projectIdFor,
  teamLegacyUuidFor,
} from "../../../src/lib/migrate/ids"

const AUTH_BASE = process.env.VITE_AUTH_BASE ?? "http://127.0.0.1:8787"
const DATABASE_URL = process.env.E2E_DATABASE_URL
const PROJECT_ID = projectIdFor("91", "gitlab")

async function seedImportedAccessTargets(): Promise<void> {
  if (!DATABASE_URL) throw new Error("E2E_DATABASE_URL is required")
  const db = new Client({ connectionString: DATABASE_URL })
  await db.connect()
  try {
    const owner = await db.query<{ id: number }>(
      "SELECT id FROM users WHERE username = 'alice'",
    )
    const ownerId = owner.rows[0]?.id
    if (!ownerId) throw new Error("seeded owner is missing")

    const org = await db.query<{ id: number }>(
      `INSERT INTO organizations (name, owner_user_id, legacy_uuid)
       VALUES ('Legacy Org', $1, $2)
       RETURNING id`,
      [ownerId, orgLegacyUuidFor(10)],
    )
    const orgId = org.rows[0]?.id
    if (!orgId) throw new Error("legacy organization target was not created")

    await db.query(
      `INSERT INTO groups (org_id, name, created_by, legacy_uuid)
       VALUES ($1, 'legacy-org/legacy-team', $2, $3)`,
      [orgId, ownerId, teamLegacyUuidFor(11)],
    )
    await db.query(
      `INSERT INTO projects (id, name, org_id, created_by)
       VALUES ($1, 'Legacy Project', $2, $3)`,
      [PROJECT_ID, orgId, ownerId],
    )
  } finally {
    await db.end()
  }
}

test.beforeEach(async () => {
  await resetBackend()
  await seedImportedAccessTargets()
})

test("a D1-only user logs in with complete access already committed", async ({ request }) => {
  const login = await request.post(`${AUTH_BASE}/api/v2/auth/token`, {
    data: {
      username: "LEGACY-E2E@EXAMPLE.TEST",
      password: "legacy-password",
    },
  })
  expect(login.status()).toBe(200)
  const session = await login.json() as {
    access_token: string
    token_type: string
    permissions_pending?: boolean
  }
  expect(session).toMatchObject({ token_type: "bearer" })
  expect(session.permissions_pending).toBeUndefined()

  const headers = { Authorization: `Bearer ${session.access_token}` }
  const orgsResponse = await request.get(`${AUTH_BASE}/api/v2/orgs`, { headers })
  expect(orgsResponse.status()).toBe(200)
  const orgs = (await orgsResponse.json()) as {
    orgs: Array<{ id: number; name: string; role: { level: number } }>
  }
  const legacyOrg = orgs.orgs.find((org) => org.name === "Legacy Org")
  expect(legacyOrg?.role.level).toBe(300)

  const projectsResponse = await request.get(
    `${AUTH_BASE}/api/v2/projects?orgId=${legacyOrg?.id}`,
    { headers },
  )
  expect(projectsResponse.status()).toBe(200)
  const projects = (await projectsResponse.json()) as {
    projects: Array<{
      id: string
      name: string
      role: { level: number; source: string }
    }>
  }
  expect(projects.projects).toContainEqual(expect.objectContaining({
    id: PROJECT_ID,
    name: "Legacy Project",
    role: expect.objectContaining({ level: 400, source: "override" }),
  }))

  if (!DATABASE_URL) throw new Error("E2E_DATABASE_URL is required")
  const db = new Client({ connectionString: DATABASE_URL })
  await db.connect()
  try {
    const committed = await db.query<{
      source_user_id: string
      imported_via: string
      org_role: number
      project_role: number
      team_count: string
    }>(
      `SELECT lil.source_user_id,
              lil.imported_via,
              om.role_level AS org_role,
              pm.role_level AS project_role,
              (
                SELECT COUNT(*)
                  FROM group_members gm
                  JOIN groups g ON g.id = gm.group_id
                 WHERE gm.user_id = u.id
                   AND g.legacy_uuid = $1
              ) AS team_count
         FROM users u
         JOIN legacy_identity_links lil ON lil.neon_user_id = u.id
         JOIN org_members om ON om.user_id = u.id
         JOIN organizations o ON o.id = om.org_id AND o.legacy_uuid = $2
         JOIN project_members pm ON pm.user_id = u.id AND pm.project_id = $3
        WHERE u.username = 'legacy-e2e'`,
      [teamLegacyUuidFor(11), orgLegacyUuidFor(10), PROJECT_ID],
    )
    expect(committed.rows).toEqual([{
      source_user_id: "700",
      imported_via: "jit",
      org_role: 300,
      project_role: 400,
      team_count: "1",
    }])
  } finally {
    await db.end()
  }
})
