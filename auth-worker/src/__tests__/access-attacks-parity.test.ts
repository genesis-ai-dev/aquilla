/**
 * AQU-1352 attack suite — parity property (ticket "try to break it" #7).
 *
 * Why: P1 promises that the access_grants view resolver is a drop-in for
 * today's per-table resolver while every team member's role_level is NULL
 * (legacy). The hand-written fixture covers the shapes someone thought of;
 * this generates 40 seeded random configurations (org role, 0-3 attached
 * teams at random levels, optional direct row, creator, archived, and a
 * sibling project the teams also reach) and demands the same level AND source
 * from both resolvers. The seed is fixed so a failure reproduces exactly.
 */

import { env } from "cloudflare:test"
import { beforeEach, describe, expect, it } from "vitest"
import { sql } from "./helpers/attack"
import { seedUser } from "./helpers/db"
import { resolveProjectRoleViaGrants } from "../../../db/shared/access-grants"
import { resolveProjectRoleShared } from "../../../db/shared/project-roles"
import { resolveProjectRole } from "../services/project-permissions"
import type { AuthUser, Env } from "../types"
import type { AquillaDb } from "../../../db/shim/postgres"

const LEVELS = [100, 200, 300, 400, 500, 600, 700] as const
const CONFIGS = 40
const SEED = 0x1352

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Config {
  i: number
  orgRole: number | null
  teams: Array<{ attachLevel: number; alsoSibling: boolean; member: boolean }>
  direct: number | null
  creator: boolean
  archived: boolean
}

function generate(): Config[] {
  const rnd = mulberry32(SEED)
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]
  const maybe = (p: number) => rnd() < p
  return Array.from({ length: CONFIGS }, (_, i) => ({
    i,
    orgRole: maybe(0.8) ? pick(LEVELS) : null,
    teams: Array.from({ length: Math.floor(rnd() * 4) }, () => ({
      attachLevel: pick(LEVELS),
      alsoSibling: maybe(0.3),
      member: maybe(0.85),
    })),
    direct: maybe(0.4) ? pick(LEVELS) : null,
    creator: maybe(0.15),
    archived: maybe(0.1),
  }))
}

async function seedConfig(c: Config): Promise<{ userId: number; pid: string }> {
  const orgId = 100 + c.i
  const userId = 1000 + c.i
  const ownerId = 5000 + c.i
  const pid = `par-${c.i}`
  await seedUser(userId, `u${c.i}`)
  await seedUser(ownerId, `own${c.i}`)
  await sql(
    "INSERT INTO organizations (id, name, owner_user_id, billing_scope) VALUES (?, ?, ?, 'team')",
    orgId,
    `Org ${c.i}`,
    ownerId,
  )
  await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, 700, ?)", orgId, ownerId, ownerId)
  if (c.orgRole != null) {
    await sql("INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)", orgId, userId, c.orgRole, ownerId)
  }
  await sql(
    `INSERT INTO projects (id, name, org_id, created_by, archived_at) VALUES (?, ?, ?, ?, ${c.archived ? "now()" : "NULL"})`,
    pid,
    `P ${c.i}`,
    orgId,
    c.creator ? userId : ownerId,
  )
  await sql("INSERT INTO projects (id, name, org_id, created_by) VALUES (?, ?, ?, ?)", `${pid}-sib`, `S ${c.i}`, orgId, ownerId)
  for (const [k, t] of c.teams.entries()) {
    const gid = 10_000 + c.i * 10 + k
    await sql("INSERT INTO groups (id, org_id, name, created_by) VALUES (?, ?, ?, ?)", gid, orgId, `t${c.i}-${k}`, ownerId)
    if (t.member) {
      await sql("INSERT INTO group_members (group_id, user_id, added_by, role_level) VALUES (?, ?, ?, NULL)", gid, userId, ownerId)
    }
    const target = t.alsoSibling && k % 2 === 1 ? `${pid}-sib` : pid
    await sql(
      "INSERT INTO group_project_grants (group_id, project_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
      gid,
      target,
      t.attachLevel,
      ownerId,
    )
  }
  if (c.direct != null) {
    await sql(
      "INSERT INTO project_members (project_id, user_id, role_level, granted_by) VALUES (?, ?, ?, ?)",
      pid,
      userId,
      c.direct,
      ownerId,
    )
  }
  return { userId, pid }
}

async function loadUser(id: number): Promise<AuthUser> {
  const row = await env.AQUILLA_PG.prepare(
    `SELECT id, username, email, password_hash, preferences, created_at, updated_at,
            password_changed_at FROM users WHERE id = ?`,
  )
    .bind(id)
    .first<AuthUser>()
  if (!row) throw new Error(`user ${id} missing`)
  return row
}

const configs = generate()

beforeEach(async () => {
  for (const c of configs) await seedConfig(c)
})

describe("AQU-1352 attack #7 resolver parity property (seeded, role_level NULL)", () => {
  it(`generator is non-trivial: covers every source at least once across ${CONFIGS} configs`, async () => {
    const db = env.AQUILLA_PG as unknown as AquillaDb
    const sources = new Set<string>()
    for (const c of configs) {
      const r = await resolveProjectRoleShared(db, { id: String(1000 + c.i) }, `par-${c.i}`, undefined, "off")
      sources.add(r?.source ?? "none")
    }
    for (const s of ["override", "group", "org", "creator", "none"]) expect(sources, `no config produced ${s}`).toContain(s)
  })

  it("resolveProjectRoleViaGrants === legacy resolveProjectRole for every config (level and source)", async () => {
    const db = env.AQUILLA_PG as unknown as AquillaDb
    const offEnv: Env = { ...(env as unknown as Env), ACCESS_GRANTS_RESOLVER: "off" }
    const diffs: string[] = []
    for (const c of configs) {
      const userId = 1000 + c.i
      for (const pid of [`par-${c.i}`, `par-${c.i}-sib`]) {
        const legacy = await resolveProjectRole(offEnv, await loadUser(userId), pid)
        const legacyShared = await resolveProjectRoleShared(db, { id: String(userId) }, pid, undefined, "off")
        const grants = await resolveProjectRoleViaGrants(db, { id: String(userId) }, pid)
        const a = legacy ? { level: legacy.level, source: legacy.source } : null
        const b = legacyShared ? { level: legacyShared.level, source: legacyShared.source } : null
        const g = grants ? { level: grants.level, source: grants.source } : null
        if (JSON.stringify(a) !== JSON.stringify(g) || JSON.stringify(b) !== JSON.stringify(g)) {
          diffs.push(`${pid} ${JSON.stringify(c)}: legacy=${JSON.stringify(a)} shared=${JSON.stringify(b)} grants=${JSON.stringify(g)}`)
        }
      }
    }
    expect(diffs).toEqual([])
  })
})
