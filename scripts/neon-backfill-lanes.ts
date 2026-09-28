#!/usr/bin/env tsx
// AQU-1240 (v2) slice 4 + AQU-730 grant phase — backfill the `lanes` table,
// populate lane_id on the eight target_lang-carrying tables, then write one
// project_member_lane_roles row per person per lane they can already see.
// Additive and non-destructive: target_lang is left untouched; this only fills
// the new lane_id columns and inserts missing grants.
//
// Per project:
//   1. Derive the lane set (pure logic in src/lib/lanes/backfill-plan.ts):
//      one source lane + a '' default target lane + one lane per distinct data
//      tag + any registry-only lanes.
//   2. Upsert those lanes (ON CONFLICT DO NOTHING on the partial unique indexes).
//   3. UPDATE ... FROM lanes to set lane_id on rows where it IS NULL, joining
//      source rows -> the source lane and target rows -> the lane whose
//      legacy_tag = target_lang.
//   4. Grant phase (src/lib/lanes/grant-backfill.ts). Role comes from
//      resolveProjectRoleShared, including archived projects so a later
//      unarchive still has rows. Maintainer (600), platform, and anyone below
//      Viewer get no rows. No kind='lane' scopes → one row per current target
//      lane. Scopes match a lane only when the scope equals that lane's
//      legacy_tag or its name. Zero matches or two matches: skip that scope
//      and print a warning. INSERT ... ON CONFLICT DO NOTHING, so a re-run
//      does not overwrite a grant a person changed later.
//
// Idempotent + resumable: upserts skip existing lanes; every UPDATE is guarded
// by `lane_id IS NULL`, so a re-run only touches unfinished rows and a run
// interrupted mid-project is safe to resume. Each statement autocommits; a
// partially-populated project stays readable because the laneOfEvent shim still
// resolves legacy '' events.
//
// DRY RUN BY DEFAULT — prints the plan and does not write. Pass --apply to write.
// A dry run before lanes exist describes grants by name and tag and says the
// ids are assigned on apply. It does not invent ids.
//
// Optional ADMIN_EMAILS (comma-separated). When set, those accounts resolve as
// platform and get no grant rows. Unset is safe: a platform admin who is also
// a member may receive rows, and the wall still shows them every lane.
//
//   pnpm neon:backfill:lanes:dev              # dry run against dev
//   pnpm neon:backfill:lanes:dev --apply      # write to dev
//   pnpm neon:backfill:lanes:prod --apply --project <id>   # one project on prod
//
// Flags: --apply  --project <id>  --limit <n>  --verbose
//        --statement-timeout <pg interval>  --lock-timeout <pg interval>
import { resolveProjectRoleIncludingArchivedShared } from '../db/shared/project-roles'
import { makePostgres, type AquillaDb } from '../db/shim/postgres'
import { planLanesForProject, type LaneRolePlan } from '../src/lib/lanes/backfill-plan'
import { planLaneGrants } from '../src/lib/lanes/grant-backfill'
import { newLaneId } from '../src/lib/lanes/lane-id'
import type { LaneIdentity } from '../src/lib/lanes/read-wall'

function connectionString(): string {
  const direct = process.env.AQUILLA_DATABASE_URL?.trim()
  if (direct) return direct
  const host = process.env.NEON_PG_HOST?.trim()
  const database = process.env.NEON_PG_DB?.trim() || 'neondb'
  const role = process.env.NEON_PG_ROLE?.trim() || 'neondb_owner'
  const password = process.env.NEON_PG_PASSWORD
  if (!host || !password) throw new Error('NEON_PG_HOST and NEON_PG_PASSWORD are required')
  const url = new URL('postgresql://placeholder')
  url.username = role
  url.password = password
  url.hostname = host
  url.pathname = `/${database}`
  url.searchParams.set('sslmode', 'require')
  return url.toString()
}

function flagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string')
  if (typeof v === 'string' && v.trim()) {
    try {
      const parsed = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.filter((x): x is string => typeof x === 'string')
    } catch {
      /* not JSON — ignore */
    }
  }
  return []
}

// Per-table lane_id population. Every UPDATE is guarded by `t.lane_id IS NULL`
// and joins to lanes on project + role/legacy_tag. Order: cells (the big one)
// last so cheaper tables finish first when a giant project times out.
const TARGET_ONLY_TABLES = [
  'cell_validators',
  'file_section_progress',
  'assignments',
  'scene_briefs',
  'contextual_runs',
  'contextual_drafts',
] as const

function targetOnlyUpdate(table: string): string {
  return `UPDATE ${table} t SET lane_id = l.id
            FROM lanes l
           WHERE t.project_id = ? AND t.lane_id IS NULL
             AND l.project_id = t.project_id
             AND l.role = 'target' AND l.legacy_tag = t.target_lang`
}

// artifact_bindings: source bindings -> the source lane; the rest by legacy_tag.
const ARTIFACT_BINDINGS_UPDATE = `UPDATE artifact_bindings t SET lane_id = l.id
    FROM lanes l
   WHERE t.project_id = ? AND t.lane_id IS NULL
     AND l.project_id = t.project_id
     AND ( (t.binding_role = 'source' AND l.role = 'source')
        OR (t.binding_role <> 'source' AND l.role = 'target' AND l.legacy_tag = t.target_lang) )`

// cells: side='source' -> the source lane; side='target' -> lane by legacy_tag.
const CELLS_UPDATE = `UPDATE cells c SET lane_id = l.id
    FROM lanes l
   WHERE c.project_id = ? AND c.lane_id IS NULL
     AND l.project_id = c.project_id
     AND ( (c.side = 'source' AND l.role = 'source')
        OR (c.side = 'target' AND l.role = 'target' AND l.legacy_tag = c.target_lang) )`

const INSERT_SOURCE = `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'source', ?, ?, NULL, ?)
   ON CONFLICT (project_id) WHERE role = 'source' DO NOTHING`

const INSERT_TARGET = `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'target', ?, ?, ?, ?)
   ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO NOTHING`

const TARGET_LANES = `SELECT id, name, legacy_tag
  FROM lanes
  WHERE project_id = ? AND role = 'target'
  ORDER BY position, id`

const GRANT_CANDIDATES = `SELECT DISTINCT u.user_id, usr.email
  FROM (
    SELECT user_id FROM project_members WHERE project_id = ?
    UNION
    SELECT gm.user_id
      FROM group_project_grants gpg
      JOIN group_members gm ON gm.group_id = gpg.group_id
     WHERE gpg.project_id = ?
    UNION
    SELECT created_by AS user_id FROM projects WHERE id = ?
  ) u
  LEFT JOIN users usr ON usr.id = u.user_id`

const LANE_SCOPES = `SELECT user_id, value
  FROM project_member_scopes
  WHERE project_id = ? AND kind = 'lane'`

const EXISTING_GRANTS = `SELECT user_id, lane
  FROM project_member_lane_roles
  WHERE project_id = ?`

const INSERT_GRANT = `INSERT INTO project_member_lane_roles
    (project_id, user_id, lane, role_level)
  VALUES (?, ?, ?, ?)
  ON CONFLICT (project_id, user_id, lane) DO NOTHING`

const MAINTAINER = 600
const VIEWER = 100

// Distinct target_lang values that actually appear in the data (target side).
// One statement, 8 project_id binds; the non-cells tables are tiny and cells is
// index-covered by (project_id, file_id, side, target_lang).
const DISTINCT_TAGS = `SELECT DISTINCT target_lang FROM (
    SELECT target_lang FROM cells WHERE project_id = ? AND side = 'target'
    UNION SELECT target_lang FROM cell_validators WHERE project_id = ?
    UNION SELECT target_lang FROM file_section_progress WHERE project_id = ?
    UNION SELECT target_lang FROM assignments WHERE project_id = ?
    UNION SELECT target_lang FROM artifact_bindings WHERE project_id = ? AND binding_role <> 'source'
    UNION SELECT target_lang FROM scene_briefs WHERE project_id = ?
    UNION SELECT target_lang FROM contextual_runs WHERE project_id = ?
    UNION SELECT target_lang FROM contextual_drafts WHERE project_id = ?
  ) t`

type ProjectRow = {
  id: string
  source_language: string | null
  target_language: string | null
  target_lanes: unknown
}

type GrantTotals = {
  planned: number
  already: number
  inserted: number
  skipped: number
  lockedOut: number
}

function emptyGrants(): GrantTotals {
  return { planned: 0, already: 0, inserted: 0, skipped: 0, lockedOut: 0 }
}

async function requireBackfillTables(db: AquillaDb): Promise<void> {
  for (const table of ['lanes', 'project_member_lane_roles', 'project_member_scopes'] as const) {
    try {
      await db.prepare(`SELECT 1 FROM ${table} LIMIT 0`).first()
    } catch {
      throw new Error(
        `${table} is missing. Apply 0091_project_member_lane_roles and 0096_lanes before this backfill.`,
      )
    }
  }
}

function unionTargetLanes(
  existing: LaneIdentity[],
  plan: readonly LaneRolePlan[],
): { lanes: LaneIdentity[]; missing: number } {
  const byTag = new Map<string, LaneIdentity>()
  for (const lane of existing) byTag.set(lane.legacyTag ?? '', lane)
  let missing = 0
  for (const planned of plan) {
    if (planned.role !== 'target') continue
    const tag = planned.legacyTag ?? ''
    if (byTag.has(tag)) continue
    missing++
    byTag.set(tag, {
      id: `planned:${tag}`,
      name: planned.name,
      legacyTag: planned.legacyTag,
    })
  }
  const lanes = [...byTag.values()].sort((a, b) => {
    const tag = (a.legacyTag ?? '').localeCompare(b.legacyTag ?? '')
    return tag !== 0 ? tag : a.id.localeCompare(b.id)
  })
  return { lanes, missing }
}

async function backfillGrants(
  db: AquillaDb,
  projectId: string,
  plan: readonly LaneRolePlan[],
  apply: boolean,
  verbose: boolean,
  adminEmails: string | undefined,
): Promise<GrantTotals> {
  const totals = emptyGrants()
  const { results: laneRows } = await db
    .prepare(TARGET_LANES)
    .bind(projectId)
    .all<{ id: string; name: string; legacy_tag: string | null }>()
  const existing: LaneIdentity[] = laneRows.map((row) => ({
    id: row.id,
    name: row.name,
    legacyTag: row.legacy_tag,
  }))
  const { lanes, missing } = unionTargetLanes(existing, plan)
  if (apply && missing > 0) {
    throw new Error(
      `refusing to grant lanes that were not inserted for ${projectId} (${missing} still unassigned)`,
    )
  }

  const { results: candidates } = await db
    .prepare(GRANT_CANDIDATES)
    .bind(projectId, projectId, projectId)
    .all<{ user_id: string | number; email: string | null }>()
  const { results: scopeRows } = await db
    .prepare(LANE_SCOPES)
    .bind(projectId)
    .all<{ user_id: string | number; value: string }>()
  const scopesByUser = new Map<string, string[]>()
  for (const row of scopeRows) {
    const id = String(row.user_id)
    const list = scopesByUser.get(id) ?? []
    list.push(row.value)
    scopesByUser.set(id, list)
  }
  const { results: grantRows } = await db
    .prepare(EXISTING_GRANTS)
    .bind(projectId)
    .all<{ user_id: string | number; lane: string }>()
  const already = new Set(grantRows.map((row) => `${String(row.user_id)}:${row.lane}`))

  const lines: string[] = []
  for (const candidate of candidates) {
    const userId = String(candidate.user_id)
    const resolution = await resolveProjectRoleIncludingArchivedShared(
      db,
      { id: userId, email: candidate.email },
      projectId,
      adminEmails,
    )
    if (
      !resolution ||
      resolution.source === 'platform' ||
      resolution.level >= MAINTAINER ||
      resolution.level < VIEWER
    ) {
      continue
    }
    const laneScopes = scopesByUser.get(userId) ?? []
    const planned = planLaneGrants({
      roleLevel: resolution.level,
      laneScopes,
      lanes,
    })
    if (laneScopes.length > 0 && planned.grants.length === 0) {
      totals.lockedOut++
      lines.push(
        `  WARN ${projectId} user ${userId} role ${resolution.level}: no target lane granted`,
      )
    }
    for (const skip of planned.skipped) {
      totals.skipped++
      lines.push(
        `  WARN ${projectId} user ${userId} scope ${JSON.stringify(skip.scope)}: ${skip.reason}`,
      )
    }
    for (const grant of planned.grants) {
      totals.planned++
      const lane = lanes.find((item) => item.id === grant.laneId)
      if (verbose) {
        const label = lane ? `${lane.name} ${lane.legacyTag === '' ? '[∅]' : `[${lane.legacyTag}]`}` : grant.laneId
        lines.push(`  grant user ${userId} role ${resolution.level} -> ${label}`)
      }
      if (already.has(`${userId}:${grant.laneId}`)) {
        totals.already++
        continue
      }
      if (!apply) continue
      if (grant.laneId.startsWith('planned:')) {
        throw new Error(`refusing to write an unassigned lane id for ${projectId}`)
      }
      const written = await db
        .prepare(INSERT_GRANT)
        .bind(projectId, userId, grant.laneId, grant.level)
        .run()
      totals.inserted += written.meta?.changes ?? 0
    }
  }

  if (verbose || !apply || lines.some((line) => line.includes('WARN'))) {
    const idNote = missing > 0 ? '; lane ids assigned on apply' : ''
    console.log(
      `  grants ${projectId}: ${totals.planned - totals.already} new, ${totals.already} already present${idNote}` +
        (totals.skipped > 0 ? `; ${totals.skipped} scope(s) skipped` : '') +
        (totals.lockedOut > 0 ? `; ${totals.lockedOut} member(s) would see no target lane` : ''),
    )
    for (const line of lines) console.log(line)
  }
  return totals
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply')
  const verbose = process.argv.includes('--verbose')
  const onlyProject = flagValue('--project')
  const limit = flagValue('--limit')
  const statementTimeout = flagValue('--statement-timeout') ?? '300s'
  const lockTimeout = flagValue('--lock-timeout') ?? '3s'

  const db = makePostgres(connectionString(), 1)
  try {
    // Prod-safety: bound each statement and never wait long on a lock.
    await db.exec(`SET statement_timeout = '${statementTimeout}'`)
    await db.exec(`SET lock_timeout = '${lockTimeout}'`)
    await requireBackfillTables(db)

    let sql = `SELECT p.id, ps.source_language, ps.target_language, ps.target_lanes
                 FROM projects p
                 LEFT JOIN project_settings ps ON ps.project_id = p.id`
    const binds: unknown[] = []
    if (onlyProject) {
      sql += ` WHERE p.id = ?`
      binds.push(onlyProject)
    }
    sql += ` ORDER BY p.id`
    if (limit) sql += ` LIMIT ${Number(limit)}`

    const { results: projects } = await db.prepare(sql).bind(...binds).all<ProjectRow>()
    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: ${projects.length} project(s); ` +
        `statement_timeout=${statementTimeout} lock_timeout=${lockTimeout}`,
    )

    let done = 0
    let lanesPlanned = 0
    const rowsUpdated: Record<string, number> = {}
    const grants = emptyGrants()
    const adminEmails = process.env.ADMIN_EMAILS
    for (const p of projects) {
      const { results: tagRows } = await db
        .prepare(DISTINCT_TAGS)
        .bind(p.id, p.id, p.id, p.id, p.id, p.id, p.id, p.id)
        .all<{ target_lang: string }>()
      const dataTargetTags = tagRows.map((r) => r.target_lang)

      const plan = planLanesForProject({
        sourceLanguage: p.source_language,
        targetLanguage: p.target_language,
        registryTargetLanes: asStringArray(p.target_lanes),
        dataTargetTags,
      })
      lanesPlanned += plan.length

      if (verbose || !apply) {
        const desc = plan
          .map((l: LaneRolePlan) =>
            l.role === 'source'
              ? `source(${l.name}/${l.langCode ?? '—'})`
              : `target[${l.legacyTag === '' ? '∅' : l.legacyTag}](${l.name}/${l.langCode ?? '—'})`,
          )
          .join(', ')
        console.log(`  ${p.id}: ${plan.length} lanes -> ${desc}`)
      }

      if (apply) {
        for (const [i, l] of plan.entries()) {
          if (l.role === 'source') {
            await db.prepare(INSERT_SOURCE).bind(newLaneId(), p.id, l.name, l.langCode, i).run()
          } else {
            await db.prepare(INSERT_TARGET).bind(newLaneId(), p.id, l.name, l.langCode, l.legacyTag, i).run()
          }
        }
        for (const table of TARGET_ONLY_TABLES) {
          const r = await db.prepare(targetOnlyUpdate(table)).bind(p.id).run()
          rowsUpdated[table] = (rowsUpdated[table] ?? 0) + (r.meta?.changes ?? 0)
        }
        const ab = await db.prepare(ARTIFACT_BINDINGS_UPDATE).bind(p.id).run()
        rowsUpdated['artifact_bindings'] = (rowsUpdated['artifact_bindings'] ?? 0) + (ab.meta?.changes ?? 0)
        const cells = await db.prepare(CELLS_UPDATE).bind(p.id).run()
        rowsUpdated['cells'] = (rowsUpdated['cells'] ?? 0) + (cells.meta?.changes ?? 0)
      }

      const projectGrants = await backfillGrants(db, p.id, plan, apply, verbose, adminEmails)
      grants.planned += projectGrants.planned
      grants.already += projectGrants.already
      grants.inserted += projectGrants.inserted
      grants.skipped += projectGrants.skipped
      grants.lockedOut += projectGrants.lockedOut

      done++
      if (done % 50 === 0 || done === projects.length) {
        console.log(`lanes backfill: ${done}/${projects.length} projects`)
      }
    }

    if (apply) {
      const total = await db
        .prepare('SELECT COUNT(*) AS n, COUNT(DISTINCT project_id) AS projects FROM lanes')
        .first<{ n: number; projects: number }>()
      console.log(`lanes backfill complete: ${total?.n} lanes across ${total?.projects} projects`)
      console.log('rows populated:', JSON.stringify(rowsUpdated))
      console.log(
        `grants inserted: ${grants.inserted} (${grants.already} already present, left as-is)`,
      )
    } else {
      console.log(`DRY RUN complete: would create ~${lanesPlanned} lanes (existing skipped on apply)`)
      console.log(
        `DRY RUN grants: ${grants.planned - grants.already} new, ${grants.already} already present`,
      )
    }
    if (grants.skipped > 0 || grants.lockedOut > 0) {
      console.log(
        `WARNING: ${grants.skipped} lane scope(s) skipped, ${grants.lockedOut} member(s) would see no target lane. ` +
          'Read those lines before deploying the read wall.',
      )
    }
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
