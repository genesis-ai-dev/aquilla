// AQU-1240 slice 6: ensure a project has first-class `lanes` rows.
//
// Live projection (slice 5) resolves `cells.lane_id` from this table. New
// projects and Codex imports therefore have to create the rows *before* the
// first cell write, or lane_id stays NULL until the backfill daemon runs.
//
// Call sites share this helper so create / settings PATCH / migrate-project /
// migrate-settings / migrate-ingest cannot drift:
//   * source lane + default target lane (`legacy_tag = ''`) always exist
//   * extra target lanes come from `targetLanes` and from data tags
//   * INSERTs are idempotent (partial unique indexes from 0096)
//   * a later named settings write may promote placeholder names, but never
//     overwrites a human rename
//
// Lives in db/shared so auth-worker and sync-worker apply the SAME writes.

import {
  BLANK_LANE_PLACEHOLDER,
  planLanesForProject,
  SOURCE_LANE_PLACEHOLDER,
  type ProjectLaneInputs,
} from "../../src/lib/lanes/backfill-plan"
import { laneNameProblem } from "../../src/lib/lanes/lane-name"
import { newLaneId } from "../../src/lib/lanes/lane-id"
import type { AquillaDb, AquillaStatement } from "../shim/postgres"

const INSERT_SOURCE = `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'source', ?, ?, NULL, ?)
   ON CONFLICT (project_id) WHERE role = 'source' DO UPDATE SET
     name = CASE
       WHEN lanes.name IN ('${SOURCE_LANE_PLACEHOLDER}') THEN excluded.name
       ELSE lanes.name
     END,
     lang_code = COALESCE(excluded.lang_code, lanes.lang_code),
     updated_at = now()`

const INSERT_TARGET = `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'target', ?, ?, ?, ?)
   ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO UPDATE SET
     name = CASE
       WHEN lanes.name IN ('${BLANK_LANE_PLACEHOLDER}') THEN excluded.name
       ELSE lanes.name
     END,
     lang_code = COALESCE(excluded.lang_code, lanes.lang_code),
     updated_at = now()`

export type LaneSettingsBlob = {
  sourceLanguage?: unknown
  targetLanguage?: unknown
  targetLanes?: unknown
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null
}

export function settingsToLaneInputs(
  settings: LaneSettingsBlob | Record<string, unknown> | null | undefined,
  dataTargetTags: string[] = [],
): ProjectLaneInputs {
  const s = settings ?? {}
  return {
    sourceLanguage: stringOrNull(s.sourceLanguage),
    targetLanguage: stringOrNull(s.targetLanguage),
    registryTargetLanes: asStringArray(s.targetLanes),
    dataTargetTags,
  }
}

/** Distinct target_lang tags carried by a batch of events (ingest / import). */
export function dataTargetTagsFromEvents(
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
): string[] {
  const tags = new Set<string>()
  for (const e of events) {
    if (!e.kind.startsWith("target.cell.")) continue
    const lang = (e.payload as { targetLang?: unknown } | null | undefined)?.targetLang
    if (typeof lang === "string") tags.add(lang)
  }
  return [...tags]
}

export function parseSettingsJson(raw: unknown): Record<string, unknown> {
  if (raw == null) return {}
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* corrupt row → empty */
    }
  }
  return {}
}

/**
 * Statements that create (or promote-from-placeholder) the project's lanes.
 * Callers that already have a batch should splice these in; otherwise use
 * {@link ensureProjectLanes}.
 */
export function ensureProjectLaneStmts(
  db: AquillaDb,
  projectId: string,
  opts?: {
    settings?: LaneSettingsBlob | Record<string, unknown> | null
    dataTargetTags?: string[]
  },
): AquillaStatement[] {
  const plan = planLanesForProject(
    settingsToLaneInputs(opts?.settings, opts?.dataTargetTags ?? []),
  )
  return plan.map((row, i) =>
    row.role === "source"
      ? db.prepare(INSERT_SOURCE).bind(newLaneId(), projectId, row.name, row.langCode, i)
      : db.prepare(INSERT_TARGET).bind(newLaneId(), projectId, row.name, row.langCode, row.legacyTag, i),
  )
}

/** Load settings if the caller did not pass them, then apply the lane stmts. */
export async function ensureProjectLanes(
  db: AquillaDb,
  projectId: string,
  opts?: {
    settings?: LaneSettingsBlob | Record<string, unknown> | null
    dataTargetTags?: string[]
  },
): Promise<void> {
  let settings = opts?.settings
  if (settings === undefined) {
    const row = await db
      .prepare(`SELECT settings FROM project_settings WHERE project_id = ?`)
      .bind(projectId)
      .first<{ settings: unknown }>()
    settings = parseSettingsJson(row?.settings)
  }
  const stmts = ensureProjectLaneStmts(db, projectId, {
    settings,
    dataTargetTags: opts?.dataTargetTags,
  })
  if (stmts.length > 0) await db.batch(stmts)
}

export interface ProjectLaneRecord {
  id: string
  role: "source" | "target"
  name: string
  langCode: string | null
  legacyTag: string | null
  position: number
  archivedAt: string | null
}

interface LaneSqlRow {
  id: string
  role: string
  name: string
  lang_code: string | null
  legacy_tag: string | null
  position: number
  archived_at: string | null
}

function toLaneRecord(row: LaneSqlRow): ProjectLaneRecord {
  return {
    id: row.id,
    role: row.role === "source" ? "source" : "target",
    name: row.name,
    langCode: row.lang_code,
    legacyTag: row.legacy_tag,
    position: row.position,
    archivedAt: row.archived_at,
  }
}

/** Target and source rows, display order. Ids are for selection, not for the screen. */
export async function listProjectLanes(
  db: AquillaDb,
  projectId: string,
): Promise<ProjectLaneRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, role, name, lang_code, legacy_tag, position, archived_at
         FROM lanes
        WHERE project_id = ?
        ORDER BY position, id`,
    )
    .bind(projectId)
    .all<LaneSqlRow>()
  return results.map(toLaneRecord)
}

export type RenameLaneResult =
  | { status: "ok"; lane: ProjectLaneRecord }
  | { status: "not_found" }
  | { status: "empty" | "too_long" | "duplicate" }

/**
 * Rename one target lane. Source rows are not renamed here. A name that
 * matches another target lane is refused so the maintainer changes one.
 * `legacy_tag` is left alone.
 */
export async function renameTargetLane(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  name: string,
): Promise<RenameLaneResult> {
  const lanes = await listProjectLanes(db, projectId)
  const current = lanes.find((lane) => lane.id === laneId && lane.role === "target")
  if (!current) return { status: "not_found" }
  const problem = laneNameProblem({
    laneId,
    name,
    others: lanes.filter((lane) => lane.role === "target"),
  })
  if (problem) return { status: problem }
  const trimmed = name.trim()
  await db
    .prepare(
      `UPDATE lanes
          SET name = ?, updated_at = now()
        WHERE project_id = ? AND id = ? AND role = 'target'`,
    )
    .bind(trimmed, projectId, laneId)
    .run()
  return { status: "ok", lane: { ...current, name: trimmed } }
}

/**
 * Insert one target lane the planner already approved. Position follows the
 * rows already on the project so the switcher order is stable.
 */
export async function insertTargetLane(
  db: AquillaDb,
  projectId: string,
  lane: { id: string; name: string; langCode: string | null; legacyTag: string },
): Promise<void> {
  const existing = await listProjectLanes(db, projectId)
  const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1
  await db
    .prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', ?, ?, ?, ?)`,
    )
    .bind(lane.id, projectId, lane.name, lane.langCode, lane.legacyTag, position)
    .run()
}

export type ArchiveLaneResult =
  | { status: "ok"; lane: ProjectLaneRecord }
  | { status: "not_found" }
  | { status: "default_lane" }

/**
 * Soft-archive a target lane (`archived_at`). The default lane (`legacy_tag`
 * '') stays; its cells are the project's primary target language.
 */
export async function setTargetLaneArchived(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  archived: boolean,
): Promise<ArchiveLaneResult> {
  const lanes = await listProjectLanes(db, projectId)
  const current = lanes.find((lane) => lane.id === laneId && lane.role === "target")
  if (!current) return { status: "not_found" }
  if (current.legacyTag === "") return { status: "default_lane" }
  const archivedAt = archived ? new Date().toISOString() : null
  await db
    .prepare(
      `UPDATE lanes
          SET archived_at = ?, updated_at = now()
        WHERE project_id = ? AND id = ? AND role = 'target'`,
    )
    .bind(archivedAt, projectId, laneId)
    .run()
  return { status: "ok", lane: { ...current, archivedAt } }
}
