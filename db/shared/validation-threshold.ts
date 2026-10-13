// AQU-1771: how many validations make a cell (validationCount) or a recorded
// take (validationCountAudio) count as validated, resolved project → org → 1.
//
// Same shape as countStructuralCells (AQU-1083): the org may set a default, a
// project may override it, and ABSENT on the project means "use the org's".
// Every value is clamped to 1..15 because the validation histograms only have
// buckets up to 15; a stored 999 would otherwise make everything permanently
// unvalidated with nothing on screen to explain it.
//
// Shared by both workers so the projection (cells.validated), the progress
// reads, the dashboards and the Monday push all resolve the same number.

import type { AquillaDb } from "../shim/postgres"
import { loadOrgVisibilityFloorsForProject } from "./visibility-floors"

export const MAX_VALIDATION_THRESHOLD = 15

export type ValidationThresholdKey = "validationCount" | "validationCountAudio"

/** The STORED generated column for each key, on both project_settings and org_settings. */
export const VALIDATION_THRESHOLD_COLUMNS: Record<ValidationThresholdKey, string> = {
  validationCount: "validation_count",
  validationCountAudio: "validation_count_audio",
}

/** Clamp any stored value to 1..15; garbage reads as 1. */
export function clampThreshold(raw: unknown): number {
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) ? Math.min(MAX_VALIDATION_THRESHOLD, Math.max(1, value)) : 1
}

/**
 * The value a settings blob (or generated column) states, or null when it
 * states none. Null means "inherit": a project with no value of its own falls
 * through to its org, and an org with none falls through to 1.
 */
export function statedThreshold(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null
  const value = Math.floor(Number(raw))
  return Number.isFinite(value) ? clampThreshold(value) : null
}

/** project → org → 1, clamped. */
export function effectiveThreshold(projectRaw: unknown, orgRaw: unknown): number {
  return statedThreshold(projectRaw) ?? statedThreshold(orgRaw) ?? 1
}

/**
 * SQL for the effective threshold given a project column and an org column
 * (both TEXT, e.g. `ps.validation_count` and `os.validation_count`). Either
 * side may be NULL from a LEFT JOIN. Non-numeric text falls through.
 */
export function effectiveThresholdSql(projectExpr: string, orgExpr: string): string {
  return `GREATEST(1, LEAST(${MAX_VALIDATION_THRESHOLD}, COALESCE(`
    + `CASE WHEN ${projectExpr} ~ '^[0-9]+$' THEN (${projectExpr})::integer END, `
    + `CASE WHEN ${orgExpr} ~ '^[0-9]+$' THEN (${orgExpr})::integer END, 1)))`
}

export interface OrgValidationDefaults {
  validationCount: number | null
  validationCountAudio: number | null
}

/**
 * The org defaults a project inherits. Both null for a project with no org,
 * or an org that set neither.
 */
export async function loadOrgValidationDefaults(
  db: AquillaDb,
  projectId: string,
): Promise<OrgValidationDefaults> {
  const row = await db
    .prepare(
      `SELECT os.validation_count, os.validation_count_audio
         FROM projects p
         JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.id = ?`,
    )
    .bind(projectId)
    .first<{ validation_count: string | null; validation_count_audio: string | null }>()
  return {
    validationCount: statedThreshold(row?.validation_count),
    validationCountAudio: statedThreshold(row?.validation_count_audio),
  }
}

/**
 * The org defaults a project's policy keys inherit when unset, keyed like the
 * settings blob — what the agent's tighten/loosen check (policy-direction.ts)
 * compares an unset key against. Only keys the org actually set appear.
 */
export async function loadInheritedPolicyDefaults(
  db: AquillaDb,
  projectId: string,
): Promise<Record<string, unknown>> {
  const [org, floors] = await Promise.all([
    loadOrgValidationDefaults(db, projectId),
    // AQU-1771: the org's visibility floors, always present for a project in
    // an org (Maintainer when the org set none). They are floors as well as
    // defaults: a project may only be stricter.
    loadOrgVisibilityFloorsForProject(db, projectId),
  ])
  const out: Record<string, unknown> = {}
  if (org.validationCount != null) out.validationCount = org.validationCount
  if (org.validationCountAudio != null) out.validationCountAudio = org.validationCountAudio
  if (floors) Object.assign(out, floors)
  return out
}

/** The effective threshold for one project, read from the generated columns only. */
export async function loadEffectiveThreshold(
  db: AquillaDb,
  projectId: string,
  key: ValidationThresholdKey,
): Promise<number> {
  const column = VALIDATION_THRESHOLD_COLUMNS[key]
  const row = await db
    .prepare(
      `SELECT ${effectiveThresholdSql(`ps.${column}`, `os.${column}`)} AS n
         FROM (SELECT ?::text AS id) q
         LEFT JOIN project_settings ps ON ps.project_id = q.id
         LEFT JOIN projects p ON p.id = q.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id`,
    )
    .bind(projectId)
    .first<{ n: number | string | null }>()
  return clampThreshold(row?.n ?? 1)
}

/**
 * Re-derive `cells.validated` and `files.approved_count` for one project at
 * the given text threshold. The org-level twin of the guarded statements the
 * project settings write batches (projects.ts validationProjectionStmts): an
 * org default or an org-wide reset moves the threshold of every project that
 * inherits it, without touching those projects' own settings rows.
 */
export function reprojectValidatedStmts(db: AquillaDb, projectId: string, threshold: number) {
  return [
    db.prepare(
      `UPDATE cells c
          SET validated = CASE WHEN (
            SELECT COUNT(*) FROM cell_validators v
             WHERE v.project_id = c.project_id
               AND v.file_id = c.file_id
               AND v.cell_id = c.cell_id
               AND v.lane_id = c.lane_id
               AND v.event_id = c.event_id
          ) >= ? THEN 1 ELSE 0 END
        WHERE c.project_id = ? AND c.side = 'target'`,
    ).bind(clampThreshold(threshold), projectId),
    db.prepare(
      `UPDATE files f
          SET approved_count = (
            SELECT COUNT(*) FROM cells c
             WHERE c.project_id = f.project_id
               AND c.file_id = f.id
               AND c.side = 'target'
               AND c.validated = 1
          )
        WHERE f.project_id = ?`,
    ).bind(projectId),
  ]
}

/**
 * Projects in an org that take the org's value for `key` (no value of their
 * own), with the threshold each now resolves to. Archived projects included:
 * their numbers must be right when they come back.
 */
export async function listInheritingProjects(
  db: AquillaDb,
  orgId: number,
  key: ValidationThresholdKey,
): Promise<Array<{ projectId: string; version: number; threshold: number }>> {
  const column = VALIDATION_THRESHOLD_COLUMNS[key]
  const { results } = await db
    .prepare(
      `SELECT p.id AS project_id,
              COALESCE(ps.version, 0) AS version,
              ${effectiveThresholdSql(`ps.${column}`, `os.${column}`)} AS n
         FROM projects p
         LEFT JOIN project_settings ps ON ps.project_id = p.id
         LEFT JOIN org_settings os ON os.org_id = p.org_id
        WHERE p.org_id = ?
          AND ps.${column} IS NULL`,
    )
    .bind(orgId)
    .all<{ project_id: string; version: number | string; n: number | string }>()
  return (results ?? []).map((row) => ({
    projectId: row.project_id,
    version: Number(row.version),
    threshold: clampThreshold(row.n),
  }))
}
