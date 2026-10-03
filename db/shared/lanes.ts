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
//   * a minted id that collides on uq_lanes_id is retried with a new id
//   * a later named settings write may promote placeholder names, but never
//     overwrites a human rename
//
// Lives in db/shared so auth-worker and sync-worker apply the SAME writes.

import {
  BLANK_LANE_PLACEHOLDER,
  codeForLanguageLabel,
  planLanesForProject,
  SOURCE_LANE_PLACEHOLDER,
  type ProjectLaneInputs,
} from "../../src/lib/lanes/backfill-plan"
import { planNewTargetLane, type ExistingLaneIdentity } from "../../src/lib/lanes/lane-create"
import { laneNameProblem, type LaneNameProblem } from "../../src/lib/lanes/lane-name"
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

/** `lanes.id` unique index (0129 / AQU-1606). Not the composite primary key. */
const LANE_ID_UNIQUE_INDEX = "uq_lanes_id"

const LANE_ID_INSERT_ATTEMPTS = 5

function laneIdConstraintName(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const record = error as Record<string, unknown>
  for (const key of ["constraint", "constraint_name"]) {
    const value = record[key]
    if (typeof value === "string" && value.length > 0) return value
  }
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string"
      ? record.message
      : ""
  return message.match(/unique constraint "([^"]+)"/)?.[1]
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const record = error as { code?: unknown; message?: unknown }
  if (record.code === "23505") return true
  return typeof record.message === "string" && record.message.includes("duplicate key")
}

/**
 * True when Postgres rejected the insert because `lanes.id` is already used
 * on any project. PGlite reports `constraint`; postgres.js reports
 * `constraint_name`. A primary-key clash inside one project is a different
 * constraint and is not this.
 */
export function isLaneIdCollision(error: unknown): boolean {
  const candidates = [error]
  if (error && typeof error === "object" && "cause" in error) {
    candidates.push((error as { cause?: unknown }).cause)
  }
  return candidates.some(
    (candidate) =>
      laneIdConstraintName(candidate) === LANE_ID_UNIQUE_INDEX && isUniqueViolation(candidate),
  )
}

/**
 * Run `run` again, up to {@link LANE_ID_INSERT_ATTEMPTS} times, when it fails
 * because a freshly minted lane id is already taken. `run` must mint those
 * ids itself: a failed attempt is one transaction and commits nothing, so
 * repeating it does not insert a second row. Any other error is rethrown.
 */
export async function retryingLaneIdCollision<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= LANE_ID_INSERT_ATTEMPTS; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt === LANE_ID_INSERT_ATTEMPTS || !isLaneIdCollision(error)) throw error
    }
  }
  throw new Error("lane id collision retries exhausted")
}

/**
 * Statements that create (or promote-from-placeholder) the project's lanes.
 * Callers that already have a batch should splice these in; otherwise use
 * {@link ensureProjectLanes}. Each call mints new ids — a batch that fails
 * on {@link LANE_ID_UNIQUE_INDEX} has to call this again inside
 * {@link retryingLaneIdCollision}.
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
  await retryingLaneIdCollision(async () => {
    const stmts = ensureProjectLaneStmts(db, projectId, {
      settings,
      dataTargetTags: opts?.dataTargetTags,
    })
    if (stmts.length > 0) await db.batch(stmts)
  })
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
 *
 * The id is the caller's. A collision on uq_lanes_id throws;
 * {@link createTargetLane} mints a new id and replans, because that id may
 * also be the legacy tag.
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

/**
 * Mint a target lane and insert it. A global id collision mints again and
 * replans, so when the legacy tag is the id itself both stay in step.
 * A name the planner refuses is returned as-is and is not retried.
 */
export async function createTargetLane(
  db: AquillaDb,
  projectId: string,
  input: {
    name: string
    language: string
    targetLanguage: string | null
    existing: readonly ExistingLaneIdentity[]
  },
): Promise<
  | { ok: true; laneId: string; name: string; legacyTag: string; langCode: string | null }
  | { ok: false; problem: LaneNameProblem }
> {
  const outcome = await retryingLaneIdCollision(async () => {
    const laneId = newLaneId()
    const plan = planNewTargetLane({
      laneId,
      name: input.name,
      language: input.language,
      targetLanguage: input.targetLanguage,
      existing: input.existing,
    })
    if (!plan.ok) return { inserted: false as const, problem: plan.problem }
    await insertTargetLane(db, projectId, {
      id: laneId,
      name: plan.name,
      langCode: plan.langCode,
      legacyTag: plan.legacyTag,
    })
    return {
      inserted: true as const,
      laneId,
      name: plan.name,
      legacyTag: plan.legacyTag,
      langCode: plan.langCode,
    }
  })
  if (!outcome.inserted) return { ok: false, problem: outcome.problem }
  return {
    ok: true,
    laneId: outcome.laneId,
    name: outcome.name,
    legacyTag: outcome.legacyTag,
    langCode: outcome.langCode,
  }
}

/**
 * Statement that makes sure a project has a target lane for `tag` — for a
 * server-side writer about to put rows under a tag the project may not have
 * yet (AQU-1550: the sibling merge), which has to splice the lane into the
 * same batch as the rows that point at it.
 *
 * The lane is what {@link ensureProjectLaneStmts} makes of a tag found in the
 * data: named after the tag, with a language code when the tag is a known
 * language. Its position follows the rows already on the project, as
 * {@link insertTargetLane} does. An existing lane for the tag — including one
 * a maintainer has renamed or archived — is left exactly as it is.
 */
export function ensureTargetLaneStmt(
  db: AquillaDb,
  projectId: string,
  tag: string,
): AquillaStatement {
  return db
    .prepare(
      `INSERT INTO lanes (id, project_id, role, name, lang_code, legacy_tag, position)
       SELECT ?, ?, 'target', ?, ?, ?, COALESCE(MAX(position), -1) + 1
         FROM lanes WHERE project_id = ?
       ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO NOTHING`,
    )
    .bind(newLaneId(), projectId, tag, codeForLanguageLabel(tag), tag, projectId)
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

/** The newest target-side edit in one lane: epoch-ms and the acting username. */
export interface LaneLastChange {
  /** `cells.last_edit_at` — epoch milliseconds. Always > 0. */
  at: number
  /**
   * `cells.last_editor` — the acting user's Aquilla *username* (the same value
   * `events.author` carries), directly displayable. NULL on rows written before
   * the column was populated, and on importer-written rows.
   */
  by: string | null
}

/**
 * AQU-1464: when was this lane last translated in, and by whom?
 *
 * Lane-SPECIFIC by product decision (2026-09-29): only `side = 'target'` rows
 * carrying this `lane_id` count. Edits in another lane, in the default lane, or
 * on the shared source do not — source rows are lane-agnostic (every lane reads
 * the same ones), so counting them would make every lane report the same date.
 *
 * Returns null when the lane has never been edited — a freshly created lane, or
 * one whose only rows live in deleted files. Callers must render that as "no
 * changes yet" rather than formatting a 0 / epoch date.
 *
 * Scoped to one project and one lane, `LIMIT 1` off `idx_cells_lane_last_edit`
 * (migration 0117), so it stays O(1) on the ~16M-row prod `cells` table. The
 * `files` join drops cells whose file was deleted: those are unreachable, so
 * they are not evidence that someone is still working in the lane. It probes
 * `files` in index order and stops at the first live row, which keeps the join
 * off the hot path in the normal case.
 */
export async function readLaneLastChange(
  db: AquillaDb,
  projectId: string,
  laneId: string,
): Promise<LaneLastChange | null> {
  const row = await db
    .prepare(
      `SELECT c.last_editor, c.last_edit_at
         FROM cells c
         JOIN files f ON f.id = c.file_id
        WHERE c.project_id = ? AND c.lane_id = ? AND c.side = 'target'
          AND f.deleted_at IS NULL
        ORDER BY c.last_edit_at DESC
        LIMIT 1`,
    )
    .bind(projectId, laneId)
    .first<{ last_editor: string | null; last_edit_at: number | string | null }>()
  if (!row) return null
  // BIGINT comes back as a string through the shim; coerce and reject a
  // missing/zero/negative stamp so the UI never formats a 1970 date.
  const at = Number(row.last_edit_at)
  if (!Number.isFinite(at) || at <= 0) return null
  return { at, by: row.last_editor ?? null }
}
