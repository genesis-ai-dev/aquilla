// AQU-1092…1098: what a PLANNING UNIT is, as SQL both workers can run.
//
// Lives in db/shared/ (taking the bare AquillaDb handle) because two callers
// need the identical definition and must never drift: sync-worker serves the
// project's plan board, and auth-worker counts units per project for the org
// table's "N of M done". A forked definition would show a different total in
// two places on the same screen.
//
// THE RULE. A planning unit is the row a project manager plans by:
//   * normally the FILE — an episode, a document, a one-book file;
//   * but where a file subdivides into parts with STABLE CANONICAL IDENTITY,
//     each part instead. Today that means the Bible books inside a Scripture
//     file, and a file that has book rows contributes NO file-grain unit.
//
// Identity is the whole point of the restriction. A target date and a Done
// mark have to find their unit again next week, and a book code survives a
// re-import byte-for-byte where a heading string does not — so flat sections
// stay drill-down detail and never become plan rows.
//
// Enumeration reads file_section_progress rather than re-deriving books from
// canonical_ref: the projection already decided which files are Scripture and
// which books they hold, and asking twice invites the two answers to differ.

import type { AquillaDb, AquillaStatement } from "../shim/postgres"

/**
 * Which files can hold plan units.
 *
 * Tombstoned files are out. So are audio-cue siblings: that role marks the
 * hidden companion file the audio workflow creates, which never appears in a
 * file list and is not something anyone plans. Every other live file is a
 * legitimate unit — `kind` is not a usable discriminator here because it falls
 * back through `role` and then to 'codex'.
 */
export const PLAN_UNIT_FILE_PREDICATE = `f.deleted_at IS NULL AND COALESCE(f.role, '') <> 'audio-cues'`

/**
 * One row per planning unit, as a subquery.
 *
 * `fileScope` is an extra predicate on alias `f` supplying the caller's own
 * binds (e.g. `f.project_id = ?`), so this composes into a bigger query
 * instead of forcing a temp table.
 *
 * The LATERAL yields either the file's distinct book keys or, when it has
 * none, a single '' row — which is exactly the "a file with books has no
 * file-grain unit" rule, expressed once.
 */
export function planUnitsSql(fileScope: string): string {
  return `SELECT f.project_id,
                 f.id          AS file_id,
                 f.name        AS file_name,
                 f.role        AS file_role,
                 f.kind        AS file_kind,
                 f.book_code   AS file_book_code,
                 f.cell_count  AS file_cell_count,
                 f.structural_cell_count AS file_structural_cell_count,
                 u.section_key
            FROM files f
            CROSS JOIN LATERAL (
              SELECT DISTINCT b.section_key
                FROM file_section_progress b
               WHERE b.project_id = f.project_id
                 AND b.file_id = f.id
                 AND b.scope = 'book'
              UNION ALL
              SELECT ''::text
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM file_section_progress b2
                  WHERE b2.project_id = f.project_id
                    AND b2.file_id = f.id
                    AND b2.scope = 'book'
               )
            ) u
           WHERE ${PLAN_UNIT_FILE_PREDICATE}
             AND (${fileScope})`
}

/** A unit's progress for one lane, plus whatever the manager has planned. */
export interface PlanUnitRow {
  project_id: string
  file_id: string
  file_name: string
  file_role: string | null
  file_kind: string | null
  file_book_code: string | null
  section_key: string
  total_count: number
  filled_count: number
  validator_histogram: Record<string, number> | string
  // AQU-1083: the structural subset, so the board can subtract like every
  // other progress surface. Same lane fallback as the columns they shadow.
  structural_count: number
  structural_filled_count: number
  structural_validator_histogram: Record<string, number> | string
  audio_count: number
  audio_validated_count: number
  // AQU-1278: and the structural share of those two, so the board subtracts
  // recorded headings exactly as it subtracts the headings themselves.
  structural_audio_count: number
  structural_audio_validated_count: number
  last_edit_at: number | null
  revision: number
  target_date: string | null
  done_at: number | null
  done_by: string | null
  progress_updated_at: number | string | null
  plan_updated_at: number | null
  plan_updated_by: string | null
}

/**
 * Units joined to their progress and plan rows.
 *
 * Binds, in order: projectId (units), lane, then whatever `extraScope` adds.
 *
 * LANE FALLBACK, and the asymmetry is deliberate. Totals, audio counts and
 * activity are lane-independent facts about the unit, so when the requested
 * lane has no projection row yet they fall back to the default-lane row.
 * Filled and validated counts do NOT fall back: a lane with no target rows is
 * genuinely 0% translated, and borrowing another lane's progress would claim
 * work that does not exist. When no projection row exists at all — a file
 * imported before the projection, or mid-backfill — total falls back to
 * files.cell_count, the same last resort the progress read uses.
 */
export function readPlanUnitsSql(extraScope = ""): string {
  // `extraScope` MUST land in a WHERE clause. Appended after the last LEFT
  // JOIN it would silently extend that join's ON condition instead — every
  // unit would still come back, and a caller reading the first row would get
  // the wrong one. The `TRUE` base keeps the composition safe when empty.
  return `WITH units AS (${planUnitsSql("f.project_id = ?")})
     SELECT u.project_id, u.file_id, u.file_name, u.file_role, u.file_kind,
            u.file_book_code, u.section_key,
            COALESCE(pl.total_count, pd.total_count,
                     CASE WHEN u.section_key = '' THEN u.file_cell_count END, 0) AS total_count,
            COALESCE(pl.filled_count, 0) AS filled_count,
            COALESCE(pl.validator_histogram, '{}'::jsonb) AS validator_histogram,
            COALESCE(pl.structural_count, pd.structural_count,
                     CASE WHEN u.section_key = '' THEN u.file_structural_cell_count END, 0) AS structural_count,
            COALESCE(pl.structural_filled_count, 0) AS structural_filled_count,
            COALESCE(pl.structural_validator_histogram, '{}'::jsonb) AS structural_validator_histogram,
            COALESCE(pd.audio_count, 0) AS audio_count,
            COALESCE(pd.audio_validated_count, 0) AS audio_validated_count,
            COALESCE(pd.structural_audio_count, 0) AS structural_audio_count,
            COALESCE(pd.structural_audio_validated_count, 0) AS structural_audio_validated_count,
            COALESCE(pl.last_edit_at, pd.last_edit_at) AS last_edit_at,
            GREATEST(COALESCE(pl.revision, 0), COALESCE(pd.revision, 0)) AS revision,
            -- The projection stamps this on every recompute. A backfill can
            -- fill in audio counts and activity WITHOUT advancing the event
            -- sequence, so the revision alone would leave the plan ETag
            -- byte-identical and a client caching an audio-less board forever.
            GREATEST(COALESCE(pl.updated_at, 0), COALESCE(pd.updated_at, 0)) AS progress_updated_at,
            pu.target_date, pu.done_at, pu.done_by,
            pu.updated_at AS plan_updated_at, pu.updated_by AS plan_updated_by
       FROM units u
       LEFT JOIN file_section_progress pd
         ON pd.project_id = u.project_id AND pd.file_id = u.file_id
        AND pd.scope = CASE WHEN u.section_key = '' THEN 'file' ELSE 'book' END
        AND pd.section_key = u.section_key
        AND pd.target_lang = ''
       LEFT JOIN file_section_progress pl
         ON pl.project_id = u.project_id AND pl.file_id = u.file_id
        AND pl.scope = CASE WHEN u.section_key = '' THEN 'file' ELSE 'book' END
        AND pl.section_key = u.section_key
        AND pl.target_lang = ?
       LEFT JOIN plan_units pu
         ON pu.project_id = u.project_id AND pu.file_id = u.file_id
        AND pu.section_key = u.section_key
      WHERE TRUE ${extraScope}`
}

/** Does this (file, sectionKey) name a real unit of this project? */
export function planUnitExistsStmt(
  db: AquillaDb,
  projectId: string,
  fileId: string,
  sectionKey: string,
): AquillaStatement {
  return db
    .prepare(
      `SELECT 1 AS ok
         FROM (${planUnitsSql("f.project_id = ? AND f.id = ?")}) u
        WHERE u.section_key = ?
        LIMIT 1`,
    )
    .bind(projectId, fileId, sectionKey)
}

export interface PlanUnitPatch {
  projectId: string
  fileId: string
  sectionKey: string
  /** undefined = leave alone; null = clear. */
  targetDate?: string | null
  /** undefined = leave alone. */
  done?: boolean
  author: string
  now: number
}

/**
 * Upsert one unit's plan.
 *
 * Each field is patched independently — setting a date must never disturb a
 * Done mark, and marking done must never disturb a date — so the two columns
 * are gated on whether the caller actually sent them.
 *
 * Marking a unit done twice keeps the FIRST mark's timestamp and author. The
 * provenance answers "who decided this was finished", and a second click by
 * someone else should not quietly reassign that.
 */
export function upsertPlanUnitStmt(db: AquillaDb, p: PlanUnitPatch): AquillaStatement {
  const patchTarget = p.targetDate !== undefined ? 1 : 0
  const patchDone = p.done !== undefined ? 1 : 0
  const doneAt = p.done ? p.now : null
  const doneBy = p.done ? p.author : null
  return db
    .prepare(
      `INSERT INTO plan_units (
         project_id, file_id, section_key, target_date, done_at, done_by, updated_at, updated_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (project_id, file_id, section_key) DO UPDATE SET
         target_date = CASE WHEN ? = 1 THEN excluded.target_date ELSE plan_units.target_date END,
         done_at = CASE
                     WHEN ? = 1 THEN CASE
                       WHEN excluded.done_at IS NULL THEN NULL
                       ELSE COALESCE(plan_units.done_at, excluded.done_at)
                     END
                     ELSE plan_units.done_at
                   END,
         done_by = CASE
                     WHEN ? = 1 THEN CASE
                       WHEN excluded.done_at IS NULL THEN NULL
                       ELSE COALESCE(plan_units.done_by, excluded.done_by)
                     END
                     ELSE plan_units.done_by
                   END,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
    )
    .bind(
      p.projectId, p.fileId, p.sectionKey,
      p.targetDate ?? null, doneAt, doneBy, p.now, p.author,
      patchTarget, patchDone, patchDone,
    )
}

/**
 * Per-project unit counts for the org table, as a CTE body.
 *
 * Binds, in order: the AoE cutoff date, then whatever `projectScope` adds.
 * Counting server-side keeps the portfolio payload scalar — shipping every
 * unit's (date, done) pair for hundreds of projects to compute one boolean
 * client-side would be a much larger response for no more information.
 */
export function planUnitCountsSql(projectScope: string): string {
  return `SELECT u.project_id,
                 COUNT(*) AS units_total,
                 COUNT(*) FILTER (WHERE pl.done_at IS NOT NULL) AS units_done,
                 COUNT(*) FILTER (
                   WHERE pl.done_at IS NULL
                     AND pl.target_date IS NOT NULL
                     AND pl.target_date < ?
                 ) AS units_overdue
            FROM (${planUnitsSql(projectScope)}) u
            LEFT JOIN plan_units pl
              ON pl.project_id = u.project_id
             AND pl.file_id = u.file_id
             AND pl.section_key = u.section_key
           GROUP BY u.project_id`
}

/**
 * Today's date in UTC-12, the last timezone on Earth to finish a day.
 *
 * A unit due on date D is late once D has ended everywhere, so `target_date <
 * aoeTodayIso(now)` is exactly the client's Anywhere-on-Earth rule expressed
 * as a string compare — which is why the count can be a SQL FILTER instead of
 * a per-row date computation.
 */
export function aoeTodayIso(now: number): string {
  return new Date(now - 12 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

export const TARGET_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * A well-formed AND real calendar date. The regex alone accepts 2026-13-45;
 * the round-trip rejects it, and rejects 2026-02-30 too.
 */
export function isValidTargetDate(value: string): boolean {
  if (!TARGET_DATE_RE.test(value)) return false
  const [y, m, d] = value.split("-").map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}
