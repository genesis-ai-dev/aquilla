// POST /migrate/groups — upsert org/team structure into Neon from a
// GroupImportPlan (orgs, org_members, teams, group_members). Completes the
// D1→Neon cutover for Layer A: migrate-groups + the content sweep used to write
// these via `wrangler d1 execute aquilla-db`; that D1 is a frozen pre-cutover
// snapshot, so new orgs never reached the live datastore. This writes them to
// Neon (env.AQUILLA_PG), gated on SYNC_SECRET_KEY.
//
// Idempotent: orgs/teams ON CONFLICT (legacy_uuid) DO NOTHING (unique indexes
// idx_organizations_legacy_uuid / idx_groups_legacy_uuid); members ON CONFLICT
// DO NOTHING on their composite PKs. Returns legacy_uuid→id maps so the caller
// can place projects without a second round-trip.

import { isAuthorizedAdminBearer } from '../lib/admin-auth'
import { countTeamLaneAccessStmt, grantTeamLaneAccessStmt } from '../../../db/shared/lane-grants'

const PATH = '/migrate/groups'

export interface MigrateGroupsEnv {
  AQUILLA_PG?: AquillaDb
  ADMIN_SECRET?: string
  SYNC_SECRET_KEY?: string
}

interface OrgCreateRow {
  legacyUuid: string
  name: string
  ownerUserId: number
}
interface OrgMemberRow {
  orgUuid: string
  userId: number
  roleLevel: number
}
interface TeamCreateRow {
  legacyUuid: string
  orgUuid: string
  name: string
  createdBy: number
}
interface TeamMemberRow {
  teamUuid: string
  userId: number
}
interface Plan {
  orgs: OrgCreateRow[]
  orgMembers: OrgMemberRow[]
  teams: TeamCreateRow[]
  teamMembers: TeamMemberRow[]
}

function isPlan(x: unknown): x is { plan: Plan; dryRun?: boolean } {
  if (typeof x !== 'object' || x === null) return false
  const p = (x as { plan?: unknown }).plan as Plan | undefined
  return (
    !!p &&
    Array.isArray(p.orgs) &&
    Array.isArray(p.orgMembers) &&
    Array.isArray(p.teams) &&
    Array.isArray(p.teamMembers)
  )
}

/** teamUuid -> the DISTINCT user ids the plan puts on that team. Distinct
 *  because the dry-run count counts the pending ids it is handed, and the same
 *  person listed twice would overstate what the apply would write. */
function membersByTeam(plan: Plan): Map<string, Set<number>> {
  const byTeam = new Map<string, Set<number>>()
  for (const m of plan.teamMembers) {
    const set = byTeam.get(m.teamUuid) ?? new Set<number>()
    set.add(m.userId)
    byTeam.set(m.teamUuid, set)
  }
  return byTeam
}

async function runBatch(db: AquillaDb, stmts: AquillaStatement[]): Promise<number> {
  if (stmts.length === 0) return 0
  const exec = db.batchPipelined ? db.batchPipelined.bind(db) : db.batch.bind(db)
  const results = await exec(stmts)
  return results.reduce((n, r) => n + (r.meta?.changes ?? 0), 0)
}

async function idMap(db: AquillaDb, table: 'organizations' | 'groups'): Promise<Map<string, number>> {
  const rows = (
    await db.prepare(`SELECT legacy_uuid, id FROM ${table} WHERE legacy_uuid IS NOT NULL`).all<{
      legacy_uuid: string
      id: number
    }>()
  ).results
  return new Map(rows.map((r) => [r.legacy_uuid, Number(r.id)]))
}

export async function handleMigrateGroupsRequest(
  request: Request,
  env: MigrateGroupsEnv,
): Promise<Response | null> {
  if (new URL(request.url).pathname !== PATH) return null
  if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
  if (!env.SYNC_SECRET_KEY) return new Response('SYNC_SECRET_KEY not configured', { status: 500 })
  if (!isAuthorizedAdminBearer(request.headers.get('Authorization') ?? '', env)) {
    return new Response('unauthorized', { status: 401 })
  }
  if (!env.AQUILLA_PG) return new Response('AQUILLA_PG binding not configured', { status: 500 })

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return new Response('invalid JSON body', { status: 400 })
  }
  if (!isPlan(body)) return new Response('body must be { plan: { orgs, orgMembers, teams, teamMembers } }', { status: 400 })
  const plan = body.plan
  const db = env.AQUILLA_PG

  // AQU-1800: the sync's dry run reports how many lane-access rows the apply
  // would add. Read-only — it writes nothing, not even the orgs and teams,
  // which is why a team the plan has yet to create contributes nothing: it has
  // no project attached, so there is no lane to grant.
  if (body.dryRun === true) {
    const teamIds = await idMap(db, 'groups')
    let laneGrants = 0
    for (const [teamUuid, pending] of membersByTeam(plan)) {
      const teamId = teamIds.get(teamUuid)
      if (teamId === undefined) continue
      const row = await countTeamLaneAccessStmt(db, teamId, [...pending]).first<{ n: number }>()
      laneGrants += Number(row?.n ?? 0)
    }
    return Response.json({
      dryRun: true,
      orgIdByUuid: Object.fromEntries(await idMap(db, 'organizations')),
      teamIdByUuid: Object.fromEntries(teamIds),
      would: { laneGrants },
    })
  }

  // 1) Orgs (new legacy_uuids only; conflicts skipped).
  const createdOrgs = await runBatch(
    db,
    plan.orgs.map((o) =>
      db
        .prepare(
          'INSERT INTO organizations (name, owner_user_id, legacy_uuid) VALUES (?, ?, ?) ON CONFLICT (legacy_uuid) DO NOTHING',
        )
        .bind(o.name, o.ownerUserId, o.legacyUuid),
    ),
  )
  const orgIdByUuid = await idMap(db, 'organizations')

  // 2) org_members (only where the org resolved).
  const createdOrgMembers = await runBatch(
    db,
    plan.orgMembers
      .filter((m) => orgIdByUuid.has(m.orgUuid))
      .map((m) =>
        db
          .prepare(
            'INSERT INTO org_members (org_id, user_id, role_level, granted_by) VALUES (?, ?, ?, NULL) ON CONFLICT DO NOTHING',
          )
          .bind(orgIdByUuid.get(m.orgUuid), m.userId, m.roleLevel),
      ),
  )

  // 3) Teams (groups) under their resolved org.
  const createdTeams = await runBatch(
    db,
    plan.teams
      .filter((t) => orgIdByUuid.has(t.orgUuid))
      .map((t) =>
        db
          .prepare(
            'INSERT INTO groups (org_id, name, created_by, legacy_uuid) VALUES (?, ?, ?, ?) ON CONFLICT (legacy_uuid) DO NOTHING',
          )
          .bind(orgIdByUuid.get(t.orgUuid), t.name, t.createdBy, t.legacyUuid),
      ),
  )
  const teamIdByUuid = await idMap(db, 'groups')

  // 4) group_members (only where the team resolved).
  const createdTeamMembers = await runBatch(
    db,
    plan.teamMembers
      .filter((m) => teamIdByUuid.has(m.teamUuid))
      .map((m) =>
        db
          .prepare('INSERT INTO group_members (group_id, user_id, added_by) VALUES (?, ?, NULL) ON CONFLICT DO NOTHING')
          .bind(teamIdByUuid.get(m.teamUuid), m.userId),
      ),
  )

  // 5) AQU-1800: lane access for the team members just written. Membership is
  //    what gives them the team's projects, and under the lane read wall a
  //    member below Maintainer with no grant row opens those projects to source
  //    text only. Runs for every team in the plan, not only the teams that
  //    gained a member: the statement selects nothing for a member who already
  //    holds grants there, so it is both idempotent and a repair for anyone the
  //    one-off AQU-730 backfill missed.
  const createdLaneGrants = await runBatch(
    db,
    [...membersByTeam(plan).keys()]
      .map((teamUuid) => teamIdByUuid.get(teamUuid))
      .filter((teamId): teamId is number => teamId !== undefined)
      .map((teamId) => grantTeamLaneAccessStmt(db, teamId, null)),
  )

  return Response.json({
    orgIdByUuid: Object.fromEntries(orgIdByUuid),
    teamIdByUuid: Object.fromEntries(teamIdByUuid),
    created: {
      orgs: createdOrgs,
      orgMembers: createdOrgMembers,
      teams: createdTeams,
      teamMembers: createdTeamMembers,
      laneGrants: createdLaneGrants,
    },
  })
}
