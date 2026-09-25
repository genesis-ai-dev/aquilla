#!/usr/bin/env tsx
// AQU-1240 (v2) slice 4 — backfill the `lanes` table and populate lane_id on the
// eight target_lang-carrying tables. Additive and non-destructive: target_lang
// is left untouched; this only fills the new lane_id columns.
//
// Per project:
//   1. Derive the lane set (pure logic in src/lib/lanes/backfill-plan.ts):
//      one source lane + a '' default target lane + one lane per distinct data
//      tag + any registry-only lanes.
//   2. Upsert those lanes (ON CONFLICT DO NOTHING on the partial unique indexes).
//   3. UPDATE ... FROM lanes to set lane_id on rows where it IS NULL, joining
//      source rows -> the source lane and target rows -> the lane whose
//      legacy_tag = target_lang.
//
// Idempotent + resumable: upserts skip existing lanes; every UPDATE is guarded
// by `lane_id IS NULL`, so a re-run only touches unfinished rows and a run
// interrupted mid-project is safe to resume. Each statement autocommits; a
// partially-populated project stays readable because the laneOfEvent shim still
// resolves legacy '' events.
//
// DRY RUN BY DEFAULT — prints the plan and does not write. Pass --apply to write.
//
//   pnpm neon:backfill:lanes:dev              # dry run against dev
//   pnpm neon:backfill:lanes:dev --apply      # write to dev
//   pnpm neon:backfill:lanes:prod --apply --project <id>   # one project on prod
//
// Flags: --apply  --project <id>  --limit <n>  --verbose
//        --statement-timeout <pg interval>  --lock-timeout <pg interval>
import { makePostgres } from '../db/shim/postgres'
import { planLanesForProject, type LaneRolePlan } from '../src/lib/lanes/backfill-plan'
import { newLaneId } from '../src/lib/lanes/lane-id'

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
    } else {
      console.log(`DRY RUN complete: would create ~${lanesPlanned} lanes (existing skipped on apply)`)
    }
  } finally {
    await db.close()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
