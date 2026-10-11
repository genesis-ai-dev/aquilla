// AQU-1840: how a stub DB answers a project_settings read.
//
// The events write path selects the `wp_*` generated columns (migration 0159)
// instead of the multi-MB `settings` blob, and falls back to the blob on a
// database that has not had 0159 applied. The hand-rolled stubs in these suites
// predate the projection and answered `{ settings }` to anything naming
// project_settings, which the projected read cannot use. Route them through
// here instead, so one place knows both shapes and every stub exercises the
// shape production actually sends.
//
// The column list comes from production, so a key added to the projection is
// automatically honoured by every stub.

import { WRITE_PATH_COLUMNS } from '../../events/write-path-settings'

export type SettingsDbMode =
  /** 0159 applied: the `wp_*` columns answer, the blob is never read. */
  | 'projected'
  /** 0159 not applied: the projected read errors and the blob answers. */
  | 'blob-only'

/**
 * The `wp_*` row Postgres projects for this blob.
 *
 * Null for no row — and also for a blob that is not a JSON object, because such
 * a row cannot exist once 0159 is applied: every generated column casts
 * `settings::jsonb`, so the write that stored it would have been rejected.
 */
export function writePathRow(settings: string | null): Record<string, unknown> | null {
  if (settings == null) return null
  let parsed: Record<string, unknown>
  try {
    const value: unknown = JSON.parse(settings)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
    parsed = value as Record<string, unknown>
  } catch {
    return null
  }
  const row: Record<string, unknown> = {}
  for (const [column, key] of Object.entries(WRITE_PATH_COLUMNS)) {
    row[column] = parsed[key] ?? null
  }
  return row
}

/**
 * Answer a `project_settings` read the way a database in `mode` would. Call it
 * from a stub's `first()` once the statement is known to name project_settings;
 * `settings` is the blob the project would hold, or null for no row.
 */
export function projectSettingsRow(
  sql: string,
  settings: string | null,
  mode: SettingsDbMode = 'projected',
): Record<string, unknown> | null {
  if (sql.includes('wp_timing_locked')) {
    if (mode === 'blob-only') {
      // What Postgres says when the projection is missing. The reader catches
      // it and reads the blob instead.
      throw new Error('column "wp_timing_locked" does not exist')
    }
    return writePathRow(settings)
  }
  return settings != null ? { settings } : null
}
