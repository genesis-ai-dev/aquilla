import type { PGlite } from "@electric-sql/pglite"

/**
 * One lane's `file_section_progress` rows.
 *
 * AQU-1599: the projection writes a row per row of `lanes`, the project's
 * SOURCE lane included. That row carries the lane-independent numbers — the
 * source-cell denominator, its structural share, the file's shared audio
 * rollup — and none of any lane's translations, so its `filled_count` is 0 by
 * design.
 *
 * `rows('file_section_progress').find(r => r.scope === 'file')` is therefore
 * ambiguous: it returns whichever lane the engine listed first, which is how
 * such an assertion can read the source lane's deliberate zero and call it a
 * regression (or, worse, pass while reading the wrong lane). Tests about a
 * lane's progress ask for that lane; tests about the denominator ask for
 * `'source'`.
 *
 * `tag` selects one target lane by its `legacy_tag` ('' is the former default
 * lane); omit it for every lane of that role.
 */
export async function progressRowsForLane<T>(
  pg: PGlite,
  projectId: string,
  role: "source" | "target",
  opts: { fileId?: string; tag?: string } = {},
): Promise<T[]> {
  const binds: unknown[] = [projectId, role]
  let extra = ""
  if (opts.fileId !== undefined) {
    binds.push(opts.fileId)
    extra += ` AND p.file_id = $${binds.length}`
  }
  if (opts.tag !== undefined) {
    binds.push(opts.tag)
    extra += ` AND l.legacy_tag = $${binds.length}`
  }
  const result = await pg.query<T & { lane_legacy_tag: string }>(
    `SELECT p.*, COALESCE(l.legacy_tag, '') AS lane_legacy_tag
       FROM file_section_progress p
       JOIN lanes l ON l.project_id = p.project_id AND l.id = p.lane_id
      WHERE p.project_id = $1 AND l.role = $2${extra}
      ORDER BY p.file_id, p.scope, p.section_key`,
    binds,
  )
  // The stored column is '' on a row this branch's writer inserted. Callers
  // read target_lang as the lane's wire tag.
  return result.rows.map((row) => {
    const { lane_legacy_tag, ...rest } = row
    return { ...rest, target_lang: lane_legacy_tag } as T
  })
}
