/**
 * AQU-1352 P1 safety net — characterization of TODAY's effective-role answers.
 *
 * The membership & permissions redesign (spec §5 P1) replaces the resolver.
 * Before it does, every (user × project) answer the product gives today is
 * pinned here end to end, at two layers:
 *   1. the resolver itself (level + attribution source), and
 *   2. what a user can observe over HTTP: project settings read, project
 *      create into an org, and org project-list membership.
 * The expected values live in helpers/access-fixture.ts as a data table. To
 * prove a new resolver behavior-preserving, point `resolverUnderTest` at it
 * and rerun: a changed cell must be a deliberate, spec-cited change.
 *
 * It also cross-checks the Agent-API port (db/shared/project-roles.ts) against
 * the auth-worker resolver — the two are hand-mirrored copies (AQU-533) and
 * the redesign collapses them into one, so any drift must be known first.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import app from "../index"
import { authHeader, jwtFor } from "./helpers/db"
import {
  EXPECTED_CAN_CREATE,
  EXPECTED_ROLES,
  FIXTURE_ORG_ID,
  FIXTURE_PROJECTS,
  FIXTURE_PROJECT_ORG,
  FIXTURE_USERS,
  PERSONAL_ORG_ID,
  seedAccessFixture,
  type ExpectedRole,
  type FixtureProject,
  type FixtureUser,
} from "./helpers/access-fixture"
import { resolveProjectRole } from "../services/project-permissions"
import {
  resolveProjectRoleShared,
  type AccessGrantsMode,
} from "../../../db/shared/project-roles"
import type { AuthUser, Env } from "../types"

/** The one seam the resolver swap turns: (user, project) → effective role. */
type AccessResolver = (user: AuthUser, projectId: string) => Promise<ExpectedRole>

/**
 * AQU-1352 P1: the matrix runs under both ACCESS_GRANTS_RESOLVER modes. `off`
 * is today's per-table resolver; `on` answers from the access_grants view. The
 * flag may only flip in production if every cell is identical in both.
 */
const MODES = ["off", "on"] as const satisfies readonly AccessGrantsMode[]

const authWorkerResolverFor =
  (mode: AccessGrantsMode): AccessResolver =>
  async (user, projectId) => {
    const modeEnv = { ...(env as unknown as Env), ACCESS_GRANTS_RESOLVER: mode }
    const role = await resolveProjectRole(modeEnv, user, projectId)
    return role ? { level: role.level, source: role.source } : null
  }

const sharedResolverFor =
  (mode: AccessGrantsMode): AccessResolver =>
  async (user, projectId) => {
    const role = await resolveProjectRoleShared(
      env.AQUILLA_PG,
      { id: String(user.id), email: user.email },
      projectId,
      env.ADMIN_EMAILS,
      mode,
    )
    return role ? { level: role.level, source: role.source as NonNullable<ExpectedRole>["source"] } : null
  }

const authWorkerResolver = authWorkerResolverFor("off")

const USERS = Object.keys(FIXTURE_USERS) as FixtureUser[]
const ORGS = [FIXTURE_ORG_ID, PERSONAL_ORG_ID]

async function loadUser(name: FixtureUser): Promise<AuthUser> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email, password_hash, preferences, created_at, updated_at,
            password_changed_at
     FROM users WHERE id = ?`,
  )
    .bind(FIXTURE_USERS[name])
    .first<AuthUser>()
  if (!row) throw new Error(`fixture user ${name} missing`)
  return row
}

async function get(path: string, name: FixtureUser): Promise<Response> {
  return app.request(path, { headers: authHeader(await jwtFor(name)) }, env)
}

beforeEach(async () => {
  await seedAccessFixture()
})

describe.each(MODES)("AQU-1352 characterization — resolver answers per (user × project), ACCESS_GRANTS_RESOLVER=%s", (mode) => {
  const resolverUnderTest = authWorkerResolverFor(mode)
  const sharedUnderTest = sharedResolverFor(mode)
  it.each(USERS)("%s resolves to the pinned level + source on every project", async (name) => {
    const user = await loadUser(name)
    const actual: Record<string, ExpectedRole> = {}
    const shared: Record<string, ExpectedRole> = {}
    for (const p of FIXTURE_PROJECTS) {
      actual[p] = await resolverUnderTest(user, p)
      shared[p] = await sharedUnderTest(user, p)
    }
    expect(actual).toEqual(EXPECTED_ROLES[name])
    // The Agent-API port answers the same table in the same mode.
    expect(shared).toEqual(EXPECTED_ROLES[name])
  })
})

describe("AQU-1352 characterization — observable HTTP results", () => {
  it.each(USERS)("%s: GET /projects/:id/settings is 200 exactly where a role resolves", async (name) => {
    // Settings read is the plainest "can open this project" gate — it 403s on
    // a null resolve and does nothing else role-dependent.
    const actual: Record<string, number> = {}
    const expected: Record<string, number> = {}
    for (const p of FIXTURE_PROJECTS) {
      actual[p] = (await get(`/api/v2/projects/${p}/settings`, name)).status
      expected[p] = EXPECTED_ROLES[name][p] ? 200 : 403
    }
    expect(actual).toEqual(expected)
  })

  it.each(USERS)("%s: GET /projects?orgId= lists exactly the reachable, unarchived projects at the resolved role", async (name) => {
    // The list is where the SPA's project.syncRole comes from (AQU-1274), so
    // it must agree with the resolver on both membership and level.
    const actual: Record<string, ExpectedRole> = {}
    for (const orgId of ORGS) {
      const res = await get(`/api/v2/projects?orgId=${orgId}`, name)
      expect(res.status).toBe(200)
      const body = (await res.json()) as {
        projects: { id: string; role: { level: number; source: string } }[]
      }
      for (const proj of body.projects) {
        actual[proj.id] = {
          level: proj.role.level,
          source: proj.role.source as NonNullable<ExpectedRole>["source"],
        }
      }
    }
    const expected: Record<string, ExpectedRole> = {}
    for (const p of FIXTURE_PROJECTS) {
      const role = EXPECTED_ROLES[name][p as FixtureProject]
      if (role) expected[p] = role
    }
    expect(actual).toEqual(expected)
  })

  it.each(USERS)("%s: POST /projects into each org is allowed exactly for org Maintainer+", async (name) => {
    // Create is an org-level right; no project or team grant confers it (Tim
    // holds team 700 on p3 yet cannot create in the org).
    const actual: Record<number, boolean> = {}
    for (const orgId of ORGS) {
      const res = await app.request(
        "/api/v2/projects",
        {
          method: "POST",
          headers: authHeader(await jwtFor(name)),
          body: JSON.stringify({ id: `new-${name}-${orgId}`, name: "New", orgId }),
        },
        env,
      )
      expect([200, 403]).toContain(res.status)
      actual[orgId] = res.status === 200
    }
    expect(actual).toEqual(EXPECTED_CAN_CREATE[name])
  })
})

describe("AQU-1352 characterization — Agent-API port agrees with auth-worker resolver", () => {
  it("resolveProjectRoleShared matches resolveProjectRole for every (user × project)", async () => {
    const disagreements: string[] = []
    for (const name of USERS) {
      const user = await loadUser(name)
      for (const p of FIXTURE_PROJECTS) {
        const a = await authWorkerResolver(user, p)
        const s = await sharedResolverFor("off")(user, p)
        if (JSON.stringify(a) !== JSON.stringify(s)) {
          disagreements.push(`${name} × ${p}: auth=${JSON.stringify(a)} shared=${JSON.stringify(s)}`)
        }
      }
    }
    expect(disagreements).toEqual([])
  })

  it("FIXTURE_PROJECT_ORG matches the seeded rows (guards the fixture itself)", async () => {
    for (const p of FIXTURE_PROJECTS) {
      const row = await env.AQUILLA_PG.prepare("SELECT org_id FROM projects WHERE id = ?")
        .bind(p)
        .first<{ org_id: number }>()
      expect(Number(row?.org_id)).toBe(FIXTURE_PROJECT_ORG[p])
    }
  })
})
