// AQU-1240 slice 6: ensure a project has first-class `lanes` rows.
//
// Live projection (slice 5) resolves `cells.lane_id` from this table. New
// projects and Codex imports therefore have to create the rows *before* the
// first cell write, or lane_id stays NULL until the backfill daemon runs.
//
// Call sites share this helper so create / migrate-project / migrate-settings /
// migrate-ingest cannot drift:
//   * it creates only the lanes the caller asked for
//   * it does NOT invent a `legacy_tag ''` target lane — that tag is only the
//     bridge for old events, created when those events (or an explicit ask)
//     name it, and never deleted or rewritten
//   * a new target lane's legacy tag is the language when that tag is free,
//     never ''
//   * INSERTs are idempotent (partial unique indexes from 0096)
//   * a minted id that collides on uq_lanes_id is retried with a new id
//   * a later ask may fill in a language that was blank, but never overwrites
//     one the user has already set, and never changes legacy_tag
//   * a later ask may retire a stored placeholder name, but never overwrites
//     a human rename
//
// Settings writes do not call this. Lanes are created and edited only by lane
// routes and by the create / seed / migrate callers below.
//
// Lives in db/shared so auth-worker and sync-worker apply the SAME writes.
//
// AQU-1592: these writers store ONLY what the user typed — `language`, plus a
// `name` / `lang_code` the user set explicitly. A display name and a language
// code are DERIVED on the read path (laneDisplayName / laneLanguageCode in
// src/lib/lanes/lane-display.ts), because a derived value captured at write
// time keeps claiming the old language after the label is edited, which is
// AQU-1585. Nothing can drift if nothing derived is stored. The one-off
// backfill of rows that predate migration 0152 is AQU-1616's.

import {
  BLANK_LANE_PLACEHOLDER,
  SOURCE_LANE_PLACEHOLDER,
  type ProjectLaneInputs,
} from "../../src/lib/lanes/backfill-plan"
import {
  canonicalLanguageCodeOverride,
  derivedLaneLanguageCode,
  laneDisplayName,
  laneLanguage,
} from "../../src/lib/lanes/lane-display"
import { planNewTargetLane, type ExistingLaneIdentity, type NewTargetLaneProblem } from "../../src/lib/lanes/lane-create"
import { laneNameProblem } from "../../src/lib/lanes/lane-name"
import { isPrimaryRegistryLane } from "../../src/lib/lanes/registry-lanes"
import { isLaneId, newLaneId } from "../../src/lib/lanes/lane-id"
import type { AquillaDb, AquillaStatement } from "../shim/postgres"

// A fresh row stores the typed language and NO name or code: both are derived
// on read. The upsert arm fills in a language that is still blank and retires a
// stored PLACEHOLDER name (a derived value written before 0152) so the derived
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
   VALUES (?, ?, 'target', ?, ?, ?, ?, ?)
   ON CONFLICT (project_id, legacy_tag) WHERE role = 'target' DO UPDATE SET
     language = COALESCE(
       CASE
         WHEN NULLIF(lanes.language, '') IS NOT NULL
          AND lanes.language <> lanes.id
          AND lanes.language !~ '^[0-9a-f]{8}$'
         THEN lanes.language
       END,
       CASE
         WHEN excluded.language <> lanes.id
          AND excluded.language !~ '^[0-9a-f]{8}$'
         THEN NULLIF(excluded.language, '')
       END
     ),
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

/**
 * Distinct target_lang tags carried by a batch of events (ingest / import).
 *
 * A target event that omits `targetLang` is the old default lane: those rows
 * were stored as `target_lang ''`, so the ask includes `''`. An explicit tag,
 * including an explicit `''`, is asked for as written. This is how old events
 * keep their bridge without every new project growing a `''` lane.
 */
export function dataTargetTagsFromEvents(
  events: ReadonlyArray<{ kind: string; payload: unknown }>,
): string[] {
  const tags = new Set<string>()
  for (const e of events) {
    if (!e.kind.startsWith("target.cell.")) continue
    const lang = (e.payload as { targetLang?: unknown } | null | undefined)?.targetLang
    tags.add(typeof lang === "string" ? lang : "")
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

/** `lanes.id` unique index (0132 / AQU-1606). Not the composite primary key. */
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

/** The shape {@link isDefaultLaneUnderAnotherName} needs of an existing lane row. */
export type ExistingLaneShape = {
  role: string
  language?: string | null
  name: string | null
  legacyTag: string | null
}

/**
 * AQU-1585: is this planned target lane just the default lane under the name it
 * already carries?
 *
 * `planLanesForProject` drops the registry entry for the primary language,
 * because the primary *is* the default lane (`legacy_tag ''`) rather than a lane
 * beside it. But it recognises the primary only by today's
 * `settings.targetLanguage`, so the moment someone changes the project target
 * language the registry's entry for the outgoing language stops looking like the
 * primary — and a project set up English -> Spanish and then moved to Portuguese
 * grew a second, empty "Spanish" lane next to the default lane that already was
 * Spanish.
 *
 * A caller that knows the project's lane rows can see that directly: a registry
 * entry naming the language the default lane is already called is that lane, not
 * a new one. Matching is by display name (`laneDisplayName`: the name, else the
 * language — AQU-1592 stores no name on a lane that only shows its language),
 * under the same rule
 * {@link isPrimaryRegistryLane} applies to `targetLanguage` — so a regional lane
 * beside its base primary ("fr-CA" next to "French", AQU-1532) still counts as
 * its own lane. Name is the right key and not the language code: two lanes may
 * deliberately share a language (AQU-1598), but lane names are unique
 * (`laneNameProblem`), so only the default lane can be called what it is called.
 *
 * Lanes a caller genuinely registers through the settings registry — the
 * external Agent API's only way to declare one, and the create dialog's extra
 * languages — name a different language, so they are untouched by this.
 */
export function isDefaultLaneUnderAnotherName(
  legacyTag: string | null,
  existingLanes: ReadonlyArray<ExistingLaneShape>,
): boolean {
  // The source lane (null) and the default lane itself ('') are never dropped.
  if (!legacyTag) return false
  const defaultLane = existingLanes.find(
    (lane) => lane.role === "target" && lane.legacyTag === "",
  )
  // No default lane yet, or one still unnamed, says nothing about this entry.
  if (!defaultLane) return false
  const label = laneDisplayName({ role: "target", name: defaultLane.name, language: defaultLane.language })
  if (label === BLANK_LANE_PLACEHOLDER) return false
  return isPrimaryRegistryLane(legacyTag, label)
}

/** One lane a caller asked to create. `legacy_tag` is never changed later. */
export interface AskedLane {
  role: "source" | "target"
  /** Stored as typed. `''` when the caller has not named a language yet. */
  language: string
  /** Optional display override. Null means "display the language". */
  name?: string | null
  /** Optional BCP 47 override. Null means "derive on read". */
  langCode?: string | null
  /**
   * Target lanes only. The immutable event key. `''` only when the caller
   * asked for the old-event bridge. Omit it and the language string is the tag.
   */
  legacyTag?: string | null
  /** Use this id when the legacy tag is the id itself. Otherwise a new id is minted. */
  id?: string
}

/**
 * The lanes a settings blob and a set of data tags actually ask for.
 *
 * A source lane is always one of them. A `legacy_tag ''` target lane is
 * included only when the data names it (old events). `targetLanguage` names
 * that bridge when it is present, and otherwise becomes a target lane whose
 * tag is the language itself — never `''`. Registry and data tags are added
 * beside it. The primary language is not added a second time.
 */
export function lanesAskedFromSettings(
  settings: LaneSettingsBlob | Record<string, unknown> | null | undefined,
  dataTargetTags: string[] = [],
): AskedLane[] {
  const input: ProjectLaneInputs = settingsToLaneInputs(settings, dataTargetTags)
  const sourceLanguage = (input.sourceLanguage ?? "").trim()
  const targetLanguage = (input.targetLanguage ?? "").trim()
  const asked: AskedLane[] = [{ role: "source", language: sourceLanguage }]
  const tags = new Set<string>()
  for (const tag of input.dataTargetTags) tags.add(tag)
  const hasBridge = tags.has("")
  if (hasBridge) {
    asked.push({ role: "target", language: targetLanguage, legacyTag: "" })
  } else if (targetLanguage) {
    tags.add(targetLanguage)
  }
  for (const raw of input.registryTargetLanes) {
    const tag = (raw ?? "").trim()
    if (!tag) continue
    if (hasBridge && isPrimaryRegistryLane(tag, targetLanguage)) continue
    if (!hasBridge && targetLanguage && isPrimaryRegistryLane(tag, targetLanguage)) continue
    tags.add(tag)
  }
  const ordered = [...tags].filter((tag) => tag !== "")
  for (const tag of ordered) {
    if (asked.some((lane) => lane.role === "target" && lane.legacyTag === tag)) continue
    const language = isLaneId(tag) ? "" : tag
    asked.push({ role: "target", language, legacyTag: tag })
  }
  return asked
}

/**
 * Statements that create (or fill-from-blank) the project's lanes.
 * Callers that already have a batch should splice these in; otherwise use
 * {@link ensureProjectLanes}. Each call mints new ids — a batch that fails
 * on {@link LANE_ID_UNIQUE_INDEX} has to call this again inside
 * {@link retryingLaneIdCollision}.
 *
 * Pass `lanes` for an explicit ask (project create). Pass `settings` and
 * `dataTargetTags` for migrate and seeds. With neither, the only lane is a
 * source lane — a target lane is not invented.
 */
export function ensureProjectLaneStmts(
  db: AquillaDb,
  projectId: string,
  opts?: {
    lanes?: readonly AskedLane[]
    settings?: LaneSettingsBlob | Record<string, unknown> | null
    dataTargetTags?: string[]
    /**
     * When the caller already has the lane rows, a registry tag that only
     * renames the `legacy_tag ''` bridge is not a new lane
     * ({@link isDefaultLaneUnderAnotherName}).
     */
    existingLanes?: ReadonlyArray<ExistingLaneShape>
  },
): AquillaStatement[] {
  const asked = opts?.lanes ?? lanesAskedFromSettings(opts?.settings, opts?.dataTargetTags ?? [])
  const existing = opts?.existingLanes
  const planned = asked.map((lane, position) => ({ lane, position }))
  const kept = existing
    ? planned.filter(({ lane }) => !isDefaultLaneUnderAnotherName(lane.legacyTag ?? null, existing))
    : planned
  return kept.map(({ lane, position }) => {
    if (lane.role === "source") {
      return db.prepare(INSERT_SOURCE).bind(lane.id ?? newLaneId(), projectId, lane.language, position)
    }
    const legacyTag = lane.legacyTag ?? lane.language
    return db.prepare(INSERT_TARGET).bind(
      lane.id ?? newLaneId(),
      projectId,
      isLaneId(lane.language) ? "" : lane.language,
      lane.name ?? null,
      lane.langCode ?? null,
      legacyTag,
      position,
    )
  })
}

/** Load settings if the caller did not pass them, then apply the lane stmts. */
export async function ensureProjectLanes(
  db: AquillaDb,
  projectId: string,
  opts?: {
    lanes?: readonly AskedLane[]
    settings?: LaneSettingsBlob | Record<string, unknown> | null
    dataTargetTags?: string[]
    existingLanes?: ReadonlyArray<ExistingLaneShape>
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
      lanes: opts?.lanes,
      settings,
      dataTargetTags: opts?.dataTargetTags,
      existingLanes: opts?.existingLanes,
    })
    if (stmts.length > 0) await db.batch(stmts)
  })
}

/**
 * SQL twin of `laneDisplayName` for queries that read lane rows without going
 * through {@link listProjectLanes}. `name` is NULL on any lane that only shows
 * its language, and grant planning and the read wall match on this string, so
 * a bare `name` silently drops those lanes. NULL when the joined row is
 * missing (a LEFT JOIN that found no lane).
 */
/** Whitespace `String.trim` drops, which default `btrim` (spaces only) leaves behind. */
const SQL_TRIM = "E' \\t\\n\\r'"

export function laneDisplayNameSql(alias: string): string {
  const trim = (column: string) => `NULLIF(btrim(${column}, ${SQL_TRIM}), '')`
  return `COALESCE(${trim(`${alias}.name`)}, ${trim(`${alias}.language`)},
    CASE ${alias}.role WHEN 'source' THEN '${SOURCE_LANE_PLACEHOLDER}' WHEN 'target' THEN '${BLANK_LANE_PLACEHOLDER}' END)`
}

export interface ProjectLaneRecord {
  id: string
  role: "source" | "target"
  /**
   * AQU-1592: the freeform language the user typed. Never derived. Null only
   * on a row that predates migration 0152 — readers fall back to `name` via
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
 * AQU-1592 / AQU-1594: edit one lane's identity — language, optional display
 * name, optional code override. Source and target rows both take this; the
 * languages screen is where either language is edited. `legacy_tag` is always
 * left alone: it is the immutable event key, and this never inserts a row.
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
  const current = lanes.find((lane) => lane.id === laneId)
  if (!current) return { status: "not_found" }

  // An untouched language keeps its stored value verbatim — including the NULL
  // a row that predates migration 0152 carries, which `laneLanguage` resolves
  // from `name`. Writing '' over that NULL would lose the "not backfilled yet"
  // distinction the AQU-1616 backfill reads.
  const previousLanguage = laneLanguage(current)
  const language = patch.language === undefined ? current.language : patch.language.trim()
  let name =
    patch.name === undefined ? current.name : patch.name === null ? null : patch.name.trim() || null

  // A pre-column row stored the derived name and code. Once the language
  // actually changes, those are a stale override of the old language — drop
  // them so display and the code follow the new language. A value the user
  // set (it doesn't match what the old language would have derived) stays.
  const languageChanged = patch.language !== undefined && (language ?? "") !== previousLanguage
  if (languageChanged && patch.name === undefined) {
    const derivedName = laneDisplayName({ role: current.role, language: previousLanguage, name: null })
    if ((name ?? "").trim() === derivedName) name = null
  }

  // A lane must still render as SOMETHING, so the language is required unless a
  // display name stands in for it. Both blank is the "empty" problem.
  const next: ProjectLaneRecord = { ...current, language, name }
  const display = laneDisplayName({ role: current.role, language, name })
  const problem = laneNameProblem({
    laneId,
    name: (language ?? "").trim() || (name ?? "").trim() ? display : "",
    others: lanes
      .filter((lane) => lane.role === current.role)
      .map((lane) => ({ id: lane.id, name: laneDisplayName(lane) })),
  })
  if (problem) return { status: problem }

  let langCode = current.langCode
  if (patch.code !== undefined) {
    const override = canonicalLanguageCodeOverride(patch.code)
    if (!override.ok) return { status: "malformed_code" }
    langCode = override.code
  } else if (languageChanged) {
    const derivedCode = derivedLaneLanguageCode({ language: previousLanguage })
    if (derivedCode && (langCode ?? "").trim().toLowerCase() === derivedCode.toLowerCase()) {
      langCode = null
    }
  }

  await db
    .prepare(
      `UPDATE lanes
          SET language = ?, name = ?, lang_code = ?, updated_at = now()
        WHERE project_id = ? AND id = ?`,
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
 *
 * The id is the caller's. A collision on uq_lanes_id throws;
 * {@link createTargetLane} mints a new id and replans, because that id may
 * also be the legacy tag.
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
    /** Optional BCP 47 override. Blank stores null and the code is derived on read. */
    code?: string | null
    targetLanguage: string | null
    existing: readonly ExistingLaneIdentity[]
  },
): Promise<
  | { ok: true; laneId: string; language: string; name: string | null; legacyTag: string; langCode: string | null }
  | { ok: false; problem: NewTargetLaneProblem }
> {
  const outcome = await retryingLaneIdCollision(async () => {
    const laneId = newLaneId()
    const plan = planNewTargetLane({
      laneId,
      name: input.name,
      language: input.language,
      code: input.code,
      targetLanguage: input.targetLanguage,
      existing: input.existing,
    })
    if (!plan.ok) return { inserted: false as const, problem: plan.problem }
    await insertTargetLane(db, projectId, {
      id: laneId,
      language: plan.language,
      name: plan.name,
      langCode: plan.langCode,
      legacyTag: plan.legacyTag,
    })
    return {
      inserted: true as const,
      laneId,
      language: plan.language,
      name: plan.name,
      legacyTag: plan.legacyTag,
      langCode: plan.langCode,
    }
  })
  if (!outcome.inserted) return { ok: false, problem: outcome.problem }
  return {
    ok: true,
    laneId: outcome.laneId,
    language: outcome.language,
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
    .bind(newLaneId(), projectId, isLaneId(tag) ? "" : tag, tag, projectId)
}

export type ArchiveLaneResult =
  | { status: "ok"; lane: ProjectLaneRecord }
  | { status: "not_found" }
  | { status: "last_lane" }

/**
 * Soft-archive a target lane (`archived_at`).
 *
 * AQU-1600: the former default lane (`legacy_tag` '') is an ordinary lane and
 * archives like any other. Its row — and its `legacy_tag ''` — stay forever,
 * so historical events still replay through it; only `archived_at` moves.
 *
 * The one refusal left is `last_lane`: a project must keep at least one
 * non-archived target lane, so archiving the last active one is rejected
 * rather than leaving a project nobody can translate in. The row's
 * `archived_at` is the only input to that count — the legacy
 * `settings.archivedLanes` mirror is a list of TAGS and cannot name the
 * former default lane (its tag is ''), so it is not consulted here.
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
  const currentlyActive = current.archivedAt == null || current.archivedAt === ""
  // Only a change that actually removes the last ACTIVE lane is refused;
  // re-archiving an already-archived lane changes no count and stays a no-op.
  if (archived && currentlyActive) {
    const stillActive = lanes.some(
      (lane) =>
        lane.role === "target" &&
        lane.id !== laneId &&
        (lane.archivedAt == null || lane.archivedAt === ""),
    )
    if (!stillActive) return { status: "last_lane" }
  }
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
