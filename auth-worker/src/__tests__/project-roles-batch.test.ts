/**
 * resolveProjectRoles is resolveProjectRole asked about a page of projects at
 * once. It exists only to cut statements (the all-organizations dashboard ran
 * 1,085 of them resolving 155 projects one by one), so its whole contract is
 * "the same answer as the one-project resolver, for every id, in every
 * ACCESS_GRANTS_RESOLVER mode". These tests hold it to that against the shared
 * access fixture rather than against a second copy of the rules.
 */

import { env } from "cloudflare:test"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  EXPECTED_ROLES,
  FIXTURE_PROJECTS,
  FIXTURE_USERS,
  seedAccessFixture,
  type FixtureUser,
} from "./helpers/access-fixture"
import {
  ROLE_NAMES,
  RoleLookupError,
  resolveProjectRole,
  resolveProjectRoles,
} from "../services/project-permissions"
import type { AccessGrantsMode } from "../../../db/shared/project-roles"
import type { AuthUser, Env } from "../types"

const MODES = ["off", "shadow", "on"] as const satisfies readonly AccessGrantsMode[]
const USERS = Object.keys(FIXTURE_USERS) as FixtureUser[]
const ASKED = [...FIXTURE_PROJECTS, "p_missing"]

async function loadUser(id: number): Promise<AuthUser> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email, password_hash, preferences, created_at, updated_at,
            password_changed_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<AuthUser>()
  if (!row) throw new Error("fixture user missing")
  return row
}

function envFor(mode: AccessGrantsMode, db: typeof env.AQUILLA_PG = env.AQUILLA_PG): Env {
  return { ...(env as unknown as Env), AQUILLA_PG: db, ACCESS_GRANTS_RESOLVER: mode }
}

async function exec(sql: string): Promise<void> {
  await env.AQUILLA_PG.prepare(sql).run()
}

// Swap the real view for an empty stand-in, or remove it (un-migrated env).
async function hideView(replaceWithEmpty: boolean): Promise<void> {
  await exec(`ALTER VIEW access_grants RENAME TO access_grants_real`)
  if (replaceWithEmpty) {
    await exec(`CREATE VIEW access_grants AS SELECT * FROM access_grants_real WHERE false`)
  }
}

/** The real database, counting every statement prepared against it. */
function countingDb(): { db: typeof env.AQUILLA_PG; statements: string[] } {
  const statements: string[] = []
  const real = env.AQUILLA_PG
  const db = {
    prepare(sql: string) {
      statements.push(sql)
      return real.prepare(sql)
    },
  } as unknown as typeof env.AQUILLA_PG
  return { db, statements }
}

/** Only the membership-path queries fail: the shape of the AQU-996 blip. */
function membershipOutageDb(): typeof env.AQUILLA_PG {
  const real = env.AQUILLA_PG
  const fail = async (): Promise<never> => {
    throw new Error("simulated membership query failure")
  }
  const failingStmt = { bind: () => failingStmt, first: fail, run: fail, all: fail, raw: fail }
  return {
    prepare(sql: string) {
      if (/\b(project_members|group_project_grants|org_members)\b/.test(sql)) return failingStmt
      return real.prepare(sql)
    },
  } as unknown as typeof env.AQUILLA_PG
}

function parityLines(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return spy.mock.calls
    .map((c: unknown[]) => c[0])
    .filter((m: unknown): m is string => typeof m === "string" && m.includes("access_grants_parity_mismatch"))
    .map((m: string) => JSON.parse(m) as Record<string, unknown>)
}

/** Every asked id through the one-project resolver, as the batch should answer. */
async function oneByOne(modeEnv: Env, user: AuthUser, ids: readonly string[]) {
  const roles = new Map<string, Awaited<ReturnType<typeof resolveProjectRole>>>()
  for (const id of ids) roles.set(id, await resolveProjectRole(modeEnv, user, id))
  return roles
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(async () => {
  await seedAccessFixture()
  warn = vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(async () => {
  warn.mockRestore()
  const hidden = await env.AQUILLA_PG.prepare(
    `SELECT 1 AS x FROM pg_views WHERE viewname = 'access_grants_real'`,
  ).first<{ x: number }>()
  if (hidden) {
    await exec(`DROP VIEW IF EXISTS access_grants`)
    await exec(`ALTER VIEW access_grants_real RENAME TO access_grants`)
  }
})

describe.each(MODES)("resolveProjectRoles, ACCESS_GRANTS_RESOLVER=%s", (mode) => {
  it.each(USERS)("%s: every project resolves to the pinned role and to what resolveProjectRole says", async (name) => {
    const user = await loadUser(FIXTURE_USERS[name])
    const batch = await resolveProjectRoles(envFor(mode), user, ASKED)

    const expected = new Map<string, unknown>([["p_missing", null]])
    for (const p of FIXTURE_PROJECTS) {
      const role = EXPECTED_ROLES[name][p]
      expected.set(p, role ? { level: role.level, name: ROLE_NAMES[role.level], source: role.source } : null)
    }
    // An entry per asked id, null included, so a caller can tell "no role"
    // from "never asked".
    expect(new Map(batch)).toEqual(expected)
    expect(new Map(batch)).toEqual(await oneByOne(envFor(mode), user, ASKED))
    expect(parityLines(warn)).toEqual([])
  })

  it("a team-scope role (AQU-1352 P2) is honoured exactly where the one-project resolver honours it", async () => {
    // team_only reaches p1/p2 through team 1 at Contributor. A team-scope
    // Maintainer role exists only in the access_grants view, so `on` answers
    // 600 while `off` and `shadow` keep 400. The batch must make the same
    // split, or the dashboard would lift the read wall on a different flag
    // setting than the editor does.
    await exec(`UPDATE group_members SET role_level = 600 WHERE group_id = 1 AND user_id = ${FIXTURE_USERS.team_only}`)
    const user = await loadUser(FIXTURE_USERS.team_only)

    const batch = await resolveProjectRoles(envFor(mode), user, ASKED)

    expect(batch.get("p1")).toEqual({
      level: mode === "on" ? 600 : 400,
      name: mode === "on" ? "maintainer" : "contributor",
      source: "group",
    })
    expect(new Map(batch)).toEqual(await oneByOne(envFor(mode), user, ASKED))
  })

  it("a project with no organization skips the org path, as it does one at a time", async () => {
    await exec(`INSERT INTO projects (id, name, created_by) VALUES ('p_noorg', 'Loose', ${FIXTURE_USERS.creator})`)
    await exec(`INSERT INTO project_members (project_id, user_id, role_level) VALUES ('p_noorg', ${FIXTURE_USERS.external}, 400)`)

    for (const name of ["creator", "external", "maintainer"] as const) {
      const user = await loadUser(FIXTURE_USERS[name])
      const batch = await resolveProjectRoles(envFor(mode), user, ["p_noorg", "p2"])
      expect(new Map(batch)).toEqual(await oneByOne(envFor(mode), user, ["p_noorg", "p2"]))
    }
    const external = await resolveProjectRoles(envFor(mode), await loadUser(FIXTURE_USERS.external), ["p_noorg"])
    expect(external.get("p_noorg")).toEqual({ level: 400, name: "contributor", source: "override" })
  })

  it("issues the same number of statements for five projects as for one", async () => {
    const user = await loadUser(FIXTURE_USERS.team_only)
    const one = countingDb()
    await resolveProjectRoles(envFor(mode, one.db), user, ["p1"])
    const five = countingDb()
    await resolveProjectRoles(envFor(mode, five.db), user, [...FIXTURE_PROJECTS])

    // projects, the platform_admins read, then the three grant paths and/or
    // the view's three reads.
    expect(one.statements).toHaveLength({ off: 5, shadow: 8, on: 5 }[mode])
    expect(five.statements).toHaveLength(one.statements.length)
  })
})

describe("resolveProjectRoles keeps the resolver's failure rules", () => {
  it("asks the database nothing for an empty page", async () => {
    const counted = countingDb()
    const roles = await resolveProjectRoles(envFor("shadow", counted.db), await loadUser(FIXTURE_USERS.owner), [])
    expect(roles.size).toBe(0)
    expect(counted.statements).toEqual([])
  })

  it("shadow returns today's answers and reports each project the view disagrees on", async () => {
    await hideView(true)
    const user = await loadUser(FIXTURE_USERS.team_only)

    const batch = await resolveProjectRoles(envFor("shadow"), user, ASKED)

    expect(batch.get("p1")).toEqual({ level: 400, name: "contributor", source: "group" })
    expect(batch.get("p2")).toEqual({ level: 400, name: "contributor", source: "group" })
    expect(batch.get("p3")).toBeNull()
    const mismatch = (projectId: string) => ({
      event: "access_grants_parity_mismatch",
      userId: String(FIXTURE_USERS.team_only),
      projectId,
      legacy: { level: 400, source: "group" },
      grants: null,
    })
    // One line per project that differs, and none for those that agree (p3 is
    // null on both sides), so the shadow log reads the same as before.
    expect(parityLines(warn).sort((a, b) => String(a.projectId).localeCompare(String(b.projectId)))).toEqual([
      mismatch("p1"),
      mismatch("p2"),
    ])
  })

  it("on trusts the view when it answers", async () => {
    await hideView(true)
    const batch = await resolveProjectRoles(envFor("on"), await loadUser(FIXTURE_USERS.team_only), ["p1", "p2"])
    expect([...batch.values()]).toEqual([null, null])
  })

  it.each(["shadow", "on"] as const)(
    "%s falls back to today's resolver when the view is missing (migration 0119 not applied)",
    async (mode) => {
      await hideView(false)
      const user = await loadUser(FIXTURE_USERS.direct_above)
      const batch = await resolveProjectRoles(envFor(mode), user, [...FIXTURE_PROJECTS])
      expect(batch.get("p1")).toEqual({ level: 600, name: "maintainer", source: "override" })
      expect(batch.get("p2")).toEqual({ level: 400, name: "contributor", source: "group" })
      expect(batch.get("p3")).toBeNull()
    },
  )

  it("AQU-996: refuses to deny when the membership queries failed", async () => {
    // team_only has no path to p3. With the lookups down that "no" cannot be
    // told from an unreadable grant, so it must not come back as null.
    const user = await loadUser(FIXTURE_USERS.team_only)
    await expect(
      resolveProjectRoles(envFor("off", membershipOutageDb()), user, ["p3"]),
    ).rejects.toBeInstanceOf(RoleLookupError)
  })

  it("AQU-996: a path that needs no membership query still resolves during the outage", async () => {
    const creator = await loadUser(FIXTURE_USERS.creator)
    const batch = await resolveProjectRoles(envFor("off", membershipOutageDb()), creator, ["p3", "p_archived"])
    expect(batch.get("p3")).toEqual({ level: 700, name: "owner", source: "creator" })
    expect(batch.get("p_archived")).toBeNull()
  })
})
