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
//   * a later named settings write may fill in a language that was blank, but
//     never overwrites one the user has already set
//
// Lives in db/shared so auth-worker and sync-worker apply the SAME writes.
//
// AQU-1592: these writers store ONLY what the user typed — `language`, plus a
// `name` / `lang_code` the user set explicitly. A display name and a language
// code are DERIVED on the read path (laneDisplayName / laneLanguageCode in
// src/lib/lanes/lane-display.ts), because a derived value captured at write
// time keeps claiming the old language after the label is edited, which is
// AQU-1585. Nothing can drift if nothing derived is stored. The one-off
// backfill of rows that predate migration 0129 is AQU-1616's.

import {
  BLANK_LANE_PLACEHOLDER,
  planLanesForProject,
  SOURCE_LANE_PLACEHOLDER,
  type ProjectLaneInputs,
} from "../../src/lib/lanes/backfill-plan"
import {
  canonicalLanguageCodeOverride,
  laneDisplayName,
} from "../../src/lib/lanes/lane-display"
import { laneNameProblem } from "../../src/lib/lanes/lane-name"
import { newLaneId } from "../../src/lib/lanes/lane-id"
import type { AquillaDb, AquillaStatement } from "../shim/postgres"

// A fresh row stores the typed language and NO name or code: both are derived
// on read. The upsert arm fills in a language that is still blank and retires a
// stored PLACEHOLDER name (a derived value written before 0129) so the derived
// display takes over — a name the user actually chose is never touched.
const INSERT_SOURCE = `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'source', ?, NULL, NULL, NULL, ?)
   ON CONFLICT (project_id) WHERE role = 'source' DO UPDATE SET
     language = COALESCE(NULLIF(lanes.language, ''), NULLIF(excluded.language, ''), lanes.language),
     name = CASE
       WHEN lanes.name IN ('${SOURCE_LANE_PLACEHOLDER}') THEN NULL
       ELSE lanes.name
     END,
     updated_at = now()`

const INSERT_TARGET = `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
   VALUES (?, ?, 'target', ?, NULL, NULL, ?, ?)
   ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO UPDATE SET
     language = COALESCE(NULLIF(lanes.language, ''), NULLIF(excluded.language, ''), lanes.language),
     name = CASE
       WHEN lanes.name IN ('${BLANK_LANE_PLACEHOLDER}') THEN NULL
       ELSE lanes.name
     END,
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
      ? db.prepare(INSERT_SOURCE).bind(newLaneId(), projectId, row.language, i)
      : db.prepare(INSERT_TARGET).bind(newLaneId(), projectId, row.language, row.legacyTag, i),
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

/**
 * SQL twin of `laneDisplayName` for queries that read lane rows without going
 * through {@link listProjectLanes}. `name` is NULL on any lane that only shows
 * its language, and grant planning and the read wall match on this string, so
 * a bare `name` silently drops those lanes. NULL when the joined row is
 * missing (a LEFT JOIN that found no lane).
 */
export function laneDisplayNameSql(alias: string): string {
  return `COALESCE(NULLIF(btrim(${alias}.name), ''), NULLIF(btrim(${alias}.language), ''),
    CASE ${alias}.role WHEN 'source' THEN '${SOURCE_LANE_PLACEHOLDER}' WHEN 'target' THEN '${BLANK_LANE_PLACEHOLDER}' END)`
}

export interface ProjectLaneRecord {
  id: string
  role: "source" | "target"
  /**
   * AQU-1592: the freeform language the user typed. Never derived. Null only
   * on a row that predates migration 0129 — readers fall back to `name` via
   * `laneLanguage` until the AQU-1616 backfill fills it.
   */
  language: string | null
  /** Optional display override. Null means "display the language". */
  name: string | null
  /** Optional BCP 47 override. Null means "derive from the language on read". */
  langCode: string | null
  legacyTag: string | null
  position: number
  archivedAt: string | null
}

interface LaneSqlRow {
  id: string
  role: string
  language: string | null
  name: string | null
  lang_code: string | null
  legacy_tag: string | null
  position: number
  archived_at: string | null
}

function toLaneRecord(row: LaneSqlRow): ProjectLaneRecord {
  return {
    id: row.id,
    role: row.role === "source" ? "source" : "target",
    language: row.language,
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
      `SELECT id, role, language, name, lang_code, legacy_tag, position, archived_at
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
  | { status: "empty" | "too_long" | "duplicate" | "malformed_code" }

/** AQU-1592: the identity fields the languages screen may edit on a lane. */
export interface LaneIdentityPatch {
  /** The freeform language. Omitted leaves it as it is; it may never be blanked. */
  language?: string
  /** The display override. `null` or "" clears it, so display falls back to the language. */
  name?: string | null
  /** The BCP 47 code override. `null` or "" clears it, so the code is derived on read. */
  code?: string | null
}

/**
 * AQU-1592: edit one target lane's identity — language, optional display name,
 * optional code override. Source rows are not edited here. `legacy_tag` is
 * always left alone: it is the immutable event key.
 *
 * The uniqueness check is on the DISPLAY name (`laneDisplayName`), not on the
 * stored `name`, because that is what people actually see: two lanes where one
 * stores a name and the other only a language still collide if both render the
 * same string. A collision is refused so the maintainer changes one; the
 * database has no unique constraint on it.
 *
 * A code override survives a language edit — that is the point of storing it
 * separately — and it is canonicalized on the way in, so "ES-mx" and "es-MX"
 * cannot be stored as two different things. A malformed tag is refused rather
 * than silently dropped.
 */
export async function updateTargetLane(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  patch: LaneIdentityPatch,
): Promise<RenameLaneResult> {
  const lanes = await listProjectLanes(db, projectId)
  const current = lanes.find((lane) => lane.id === laneId && lane.role === "target")
  if (!current) return { status: "not_found" }

  // An untouched language keeps its stored value verbatim — including the NULL
  // a row that predates migration 0129 carries, which `laneLanguage` resolves
  // from `name`. Writing '' over that NULL would lose the "not backfilled yet"
  // distinction the AQU-1616 backfill reads.
  const language = patch.language === undefined ? current.language : patch.language.trim()
  const name =
    patch.name === undefined ? current.name : patch.name === null ? null : patch.name.trim() || null

  // A lane must still render as SOMETHING, so the language is required unless a
  // display name stands in for it. Both blank is the "empty" problem.
  const next: ProjectLaneRecord = { ...current, language, name }
  const display = laneDisplayName({ role: "target", language, name })
  const problem = laneNameProblem({
    laneId,
    name: (language ?? "").trim() || (name ?? "").trim() ? display : "",
    others: lanes
      .filter((lane) => lane.role === "target")
      .map((lane) => ({ id: lane.id, name: laneDisplayName(lane) })),
  })
  if (problem) return { status: problem }

  let langCode = current.langCode
  if (patch.code !== undefined) {
    const override = canonicalLanguageCodeOverride(patch.code)
    if (!override.ok) return { status: "malformed_code" }
    langCode = override.code
  }

  await db
    .prepare(
      `UPDATE lanes
          SET language = ?, name = ?, lang_code = ?, updated_at = now()
        WHERE project_id = ? AND id = ? AND role = 'target'`,
    )
    .bind(language, name, langCode, projectId, laneId)
    .run()
  return { status: "ok", lane: { ...next, langCode } }
}

/**
 * Rename one target lane — the display-name-only edit the languages screen has
 * always offered. Thin wrapper over {@link updateTargetLane}; a blank name
 * clears the override so the lane falls back to showing its language.
 */
export async function renameTargetLane(
  db: AquillaDb,
  projectId: string,
  laneId: string,
  name: string,
): Promise<RenameLaneResult> {
  return updateTargetLane(db, projectId, laneId, { name })
}

/**
 * Insert one target lane the planner already approved. Position follows the
 * rows already on the project so the switcher order is stable.
 */
export async function insertTargetLane(
  db: AquillaDb,
  projectId: string,
  lane: {
    id: string
    /** AQU-1592: required, freeform, stored exactly as typed. */
    language: string
    /** Optional display override — null when the lane just shows its language. */
    name: string | null
    /** Optional BCP 47 override — null when the code is derived on read. */
    langCode: string | null
    legacyTag: string
  },
): Promise<void> {
  const existing = await listProjectLanes(db, projectId)
  const position = existing.reduce((max, row) => Math.max(max, row.position), -1) + 1
  await db
    .prepare(
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       VALUES (?, ?, 'target', ?, ?, ?, ?, ?)`,
    )
    .bind(lane.id, projectId, lane.language, lane.name, lane.langCode, lane.legacyTag, position)
    .run()
}

/**
 * Statement that makes sure a project has a target lane for `tag` — for a
 * server-side writer about to put rows under a tag the project may not have
 * yet (AQU-1550: the sibling merge), which has to splice the lane into the
 * same batch as the rows that point at it.
 *
 * The lane is what {@link ensureProjectLaneStmts} makes of a tag found in the
 * data: the tag IS its language (AQU-1592 — tags are language labels), with no
 * stored name or code, so both are derived on read. Its position follows the
 * rows already on the project, as
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
      `INSERT INTO lanes (id, project_id, role, language, name, lang_code, legacy_tag, position)
       SELECT ?, ?, 'target', ?, NULL, NULL, ?, COALESCE(MAX(position), -1) + 1
         FROM lanes WHERE project_id = ?
       ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO NOTHING`,
    )
    .bind(newLaneId(), projectId, tag, tag, projectId)
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
