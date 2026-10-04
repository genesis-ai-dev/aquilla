// Which files COUNT, as SQL predicates both workers can run. (AQU-1626)
//
// A project's file list is not the same thing as its work. Two roles mark a
// HIDDEN companion file — a row the importer creates to hold machinery, which
// never appears in a file list and which nobody plans, measures or translates:
//
//   * `audio-cues`      — the cue sheet an audio/dub workflow records against
//                         (see migrations/0073_cell_links.sql).
//   * `timeline-content` — a linked video's caption-track content.
//
// Both can be large. A 500-cue caption track added 500 untranslated cells to
// the org dashboard, so a team that linked one video watched its completion
// percentage fall for work it had never been asked to do — which is the bug
// AQU-1626 exists to stop. Tombstoned (`deleted_at`) files counted for the same
// reason: deleting a file took its rows out of the editor but not out of the
// rollups.
//
// WHY ONE DEFINITION. The plan board already counted correctly
// (`PLAN_UNIT_FILE_PREDICATE`, which is now `countedFileSql('f')`), so the org
// dashboard showed a different total from the board on the same screen. There
// is no second rule to keep in step: every surface that measures work reaches
// for this module, and the roles are listed once.
//
// WHAT THIS IS NOT. It is not an access predicate — a hidden file is ordinary
// content its project's members may read. Fetching one BY ID still works, and
// must: the audio workflow follows `anchor_file_id` to its cue sheet. Hiding
// applies to LISTS, TOTALS and SEARCH, never to a direct lookup.
//
// The client's mirror of the role names is `AUDIO_CUES_ROLE` /
// `TIMELINE_CONTENT_ROLE` in src/lib/parsers/types.ts.

/** The `files.role` values that mark a hidden companion file. */
export const HIDDEN_FILE_ROLES = ['audio-cues', 'timeline-content'] as const

const HIDDEN_ROLE_LIST = HIDDEN_FILE_ROLES.map((role) => `'${role}'`).join(', ')

/**
 * "`<alias>` is not a hidden companion file" — the ROLE half on its own.
 *
 * For the one caller that has already picked its side of the tombstone and
 * means it: the trash listing, whose whole purpose is `deleted_at IS NOT NULL`.
 * Everything that measures live work wants `countedFileSql` instead.
 *
 * `COALESCE` rather than a bare comparison because `role` is nullable and a
 * NULL would make `NOT IN` evaluate to NULL — dropping every ordinary file.
 */
export function notHiddenFileSql(alias = 'f'): string {
  return `COALESCE(${alias}.role, '') NOT IN (${HIDDEN_ROLE_LIST})`
}

/** "`<alias>` is a file whose rows are WORK" — live and not hidden. */
export function countedFileSql(alias = 'f'): string {
  return `${alias}.deleted_at IS NULL AND ${notHiddenFileSql(alias)}`
}

/**
 * The anti-join form, for a row that carries `project_id` / `file_id` but has
 * no `files` join to hang a predicate on — progress rows, cells, audio takes.
 *
 * NOT EXISTS over the uncounted files, rather than EXISTS over the counted
 * ones, and the difference is not cosmetic: a row whose `files` row is missing
 * stays IN. That is the same way `hidden-cells-scope.ts` treats a missing
 * source row, and it is the safe direction — a projection that has a cell but
 * not yet its file (or a fixture that never seeded one) must not have its work
 * silently vanish from every total. Only a file that is present AND uncounted
 * takes its rows out.
 *
 * Cost: one lookup on the `files` primary key per candidate row, so this is a
 * probe rather than a scan. `probe` names the correlation; override it only to
 * avoid a collision with an alias already in the query.
 */
export function inCountedFileSql(alias: string, probe = 'uncounted_file'): string {
  return `NOT EXISTS (
    SELECT 1 FROM files ${probe}
     WHERE ${probe}.id = ${alias}.file_id
       AND ${probe}.project_id = ${alias}.project_id
       AND (${probe}.deleted_at IS NOT NULL
            OR COALESCE(${probe}.role, '') IN (${HIDDEN_ROLE_LIST}))
  )`
}
